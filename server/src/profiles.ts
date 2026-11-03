import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import ffmpegStatic from "ffmpeg-static";
import { CLIP_SLOTS, type ClipSlot, type TeamProfileView } from "@lootbot/shared";

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || (ffmpegStatic as unknown as string | null);

export const IMAGE_MAX_BYTES = 1024 * 1024;
export const CLIP_MAX_BYTES = 500 * 1024;
export const CLIP_MAX_SEC = 3;
/** Every clip is normalised to this loudness (EBU R128 integrated, LUFS). */
const TARGET_LUFS = -16;

export interface UploadedFile {
  field: string;
  name: string;
  size: number;
  buffer: Buffer;
}

/** A processed profile as stored in `uploads/<id>/profile.json`. */
export interface StoredProfile {
  id: string;
  teamName: string;
  icon: string | null;
  driver: string | null;
  passengers: string[];
  clips: Partial<Record<ClipSlot, string>>;
  clipDurations: Partial<Record<ClipSlot, number>>;
  notes: string[];
}

export class ProfileError extends Error {
  constructor(public errors: string[]) {
    super(errors.join(" "));
  }
}

/** Form field names accepted by `POST /api/profile`. */
export const IMAGE_FIELDS = ["icon", "driver", "passenger1", "passenger2", "passenger3", "passenger4"] as const;
export const CLIP_FIELDS = CLIP_SLOTS.map((s) => `clip_${s}`);
const FIELD_LABEL: Record<string, string> = {
  icon: "Icon",
  driver: "Driver photo",
  passenger1: "Passenger photo 1",
  passenger2: "Passenger photo 2",
  passenger3: "Passenger photo 3",
  passenger4: "Passenger photo 4",
  clip_gift: "Clip: gift collected",
  clip_hitEnemy: "Clip: hit an enemy",
  clip_gotHit: "Clip: got hit",
  clip_death: "Clip: death",
  clip_win: "Clip: win",
};
export const fieldLabel = (f: string) => FIELD_LABEL[f] ?? f;

/**
 * Team profile uploads: checks limits, resizes images, trims and normalises clips,
 * and stores everything under `uploads/<id>/`, served at `/uploads/<id>/…`.
 */
export class ProfileStore {
  private cache = new Map<string, StoredProfile>();

  constructor(private dir: string) {}

  static ffmpegAvailable() {
    return Boolean(FFMPEG && existsSync(FFMPEG));
  }

  async create(teamName: string, files: UploadedFile[]): Promise<StoredProfile> {
    const errors: string[] = [];
    const team = teamName.trim();
    if (!team) errors.push("Team name is required.");
    if (team.length > 20) errors.push("Team name must be at most 20 characters.");
    for (const f of files) {
      const label = fieldLabel(f.field);
      if (IMAGE_FIELDS.includes(f.field as never)) {
        if (f.size > IMAGE_MAX_BYTES) errors.push(`${label} is ${kb(f.size)}; the limit is 1 MB.`);
        else if (!(await isPngOrJpeg(f.buffer))) errors.push(`${label} must be a PNG or JPG image.`);
      } else if (CLIP_FIELDS.includes(f.field)) {
        if (f.size > CLIP_MAX_BYTES) errors.push(`${label} is ${kb(f.size)}; the limit is 500 KB.`);
        else if (!/\.(mp3|wav|ogg)$/i.test(f.name)) errors.push(`${label} must be an MP3, WAV or OGG file.`);
      } else {
        errors.push(`Unknown upload field "${f.field}".`);
      }
    }
    if (errors.length) throw new ProfileError(errors);

    const id = `p_${randomBytes(6).toString("hex")}`;
    const out = path.join(this.dir, id);
    await mkdir(out, { recursive: true });
    const url = (file: string) => `/uploads/${id}/${file}`;
    const profile: StoredProfile = { id, teamName: team, icon: null, driver: null, passengers: [], clips: {}, clipDurations: {}, notes: [] };

    try {
      for (const f of files) {
        if (f.field === "icon") {
          // Square crop for the car and scoreboard.
          await sharp(f.buffer).rotate().resize(256, 256, { fit: "cover" }).png().toFile(path.join(out, "icon.png"));
          profile.icon = url("icon.png");
        } else if (f.field === "driver" || f.field.startsWith("passenger")) {
          const file = `${f.field}.jpg`;
          await sharp(f.buffer).rotate().resize(600, 600, { fit: "cover" }).jpeg({ quality: 82 }).toFile(path.join(out, file));
          if (f.field === "driver") profile.driver = url(file);
          else profile.passengers.push(url(file));
        }
      }
      profile.passengers.sort();

      for (const f of files.filter((x) => CLIP_FIELDS.includes(x.field))) {
        const slot = f.field.slice(5) as ClipSlot;
        const label = fieldLabel(f.field);
        if (!ProfileStore.ffmpegAvailable()) {
          // Without ffmpeg the clip is kept as uploaded and cannot be trimmed or levelled.
          const file = `${slot}${path.extname(f.name).toLowerCase()}`;
          await writeFile(path.join(out, file), f.buffer);
          profile.clips[slot] = url(file);
          profile.clipDurations[slot] = CLIP_MAX_SEC;
          profile.notes.push(`${label}: not normalised (ffmpeg missing).`);
          continue;
        }
        try {
          const { duration, trimmed } = await normaliseClip(f, path.join(out, `${slot}.mp3`));
          profile.clips[slot] = url(`${slot}.mp3`);
          profile.clipDurations[slot] = duration;
          if (trimmed) profile.notes.push(`${label} trimmed to ${CLIP_MAX_SEC} s.`);
        } catch {
          profile.notes.push(`${label} could not be decoded and was skipped.`);
        }
      }
    } catch (e) {
      await rm(out, { recursive: true, force: true });
      throw new ProfileError([`Could not process the files: ${(e as Error).message}`]);
    }

    await writeFile(path.join(out, "profile.json"), JSON.stringify(profile, null, 2));
    this.cache.set(id, profile);
    return profile;
  }

  async get(id: string): Promise<StoredProfile | null> {
    if (!/^p_[0-9a-f]{12}$/.test(id)) return null;
    const hit = this.cache.get(id);
    if (hit) return hit;
    try {
      const p: StoredProfile = JSON.parse(await readFile(path.join(this.dir, id, "profile.json"), "utf8"));
      this.cache.set(id, p);
      return p;
    } catch {
      return null;
    }
  }

  /** Synchronous lookup for profiles uploaded since the server started (or loaded via `get`). */
  getCached(id: string) {
    return this.cache.get(id) ?? null;
  }
}

/** The stage-facing view of a stored profile. */
export function toView(p: StoredProfile, team: string, color: string): TeamProfileView {
  return { team, icon: p.icon, driver: p.driver, passengers: p.passengers, clips: p.clips, color, clipDurations: p.clipDurations };
}

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

async function isPngOrJpeg(buf: Buffer) {
  try {
    const m = await sharp(buf).metadata();
    return m.format === "png" || m.format === "jpeg";
  } catch {
    return false;
  }
}

/** Trim to 3 s, mix to mono and level to the target loudness, writing an MP3. */
async function normaliseClip(f: UploadedFile, outFile: string) {
  const tmp = `${outFile}.src${path.extname(f.name).toLowerCase()}`;
  await writeFile(tmp, f.buffer);
  try {
    const probe = await run(FFMPEG!, ["-hide_banner", "-i", tmp, "-f", "null", "-"]).catch((e) => e);
    const srcDuration = parseDuration(String(probe.stderr ?? ""));
    if (srcDuration === null) throw new Error("not audio");
    await run(FFMPEG!, [
      "-hide_banner", "-y", "-i", tmp,
      "-t", String(CLIP_MAX_SEC),
      "-af", `loudnorm=I=${TARGET_LUFS}:TP=-1.5:LRA=11,afade=t=out:st=${Math.max(0, Math.min(srcDuration, CLIP_MAX_SEC) - 0.05)}:d=0.05`,
      "-ac", "1", "-ar", "44100", "-codec:a", "libmp3lame", "-b:a", "96k",
      outFile,
    ]);
    return { duration: Math.min(srcDuration, CLIP_MAX_SEC), trimmed: srcDuration > CLIP_MAX_SEC + 0.05 };
  } finally {
    await rm(tmp, { force: true });
  }
}

function parseDuration(stderr: string) {
  if (!/Audio:/.test(stderr)) return null;
  const m = stderr.match(/Duration: (\d+):(\d+):([\d.]+)/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}
