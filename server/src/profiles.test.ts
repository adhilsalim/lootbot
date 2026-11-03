import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import ffmpeg from "ffmpeg-static";
import { startTestApp, TestClient } from "./testUtil.js";

const FF = ffmpeg as unknown as string;
let png: Buffer;
let bigPng: Buffer;
let longWav: Buffer;
let quietWav: Buffer;

/** Integrated loudness of an audio file in LUFS. */
function measure(file: string) {
  const r = spawnSync(FF, ["-hide_banner", "-nostats", "-i", file, "-af", "ebur128", "-f", "null", "-"]);
  const m = String(r.stderr).match(/I:\s+(-?[\d.]+) LUFS\s*\n\s*Threshold/);
  return m ? Number(m[1]) : NaN;
}

beforeAll(async () => {
  png = await sharp({ create: { width: 800, height: 500, channels: 3, background: "#3366ff" } }).png().toBuffer();
  // Random noise doesn't compress: ~1.5 MB.
  const noise = Buffer.alloc(800 * 650 * 3);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24;
  bigPng = await sharp(noise, { raw: { width: 800, height: 650, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
  const dir = mkdtempSync(path.join(tmpdir(), "lootbot-audio-"));
  const gen = (name: string, secs: number, volume: number) => {
    const f = path.join(dir, name);
    execFileSync(FF, ["-hide_banner", "-y", "-f", "lavfi", "-i", `sine=frequency=440:duration=${secs}`, "-af", `volume=${volume}`, "-ar", "8000", "-ac", "1", f], { stdio: "pipe" });
    return readFileSync(f);
  };
  longWav = gen("long.wav", 5, 1);
  quietWav = gen("quiet.wav", 1, 0.02);
});

describe("profile uploads", () => {
  let ctx: Awaited<ReturnType<typeof startTestApp>>;
  let base: string;
  const upload = async (fields: Record<string, [Buffer, string] | string>) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      if (typeof v === "string") fd.append(k, v);
      else fd.append(k, new Blob([new Uint8Array(v[0])]), v[1]);
    }
    const res = await fetch(`${base}/api/profile`, { method: "POST", body: fd });
    return { status: res.status, body: await res.json() };
  };

  beforeEach(async () => {
    ctx = await startTestApp();
    base = `http://localhost:${ctx.app.port}`;
  });
  afterEach(() => ctx.app.close());

  it("resizes images, trims and levels clips", async () => {
    const r = await upload({
      teamName: "Falcon",
      icon: [png, "icon.png"],
      driver: [png, "d.png"],
      passenger1: [png, "p1.png"],
      passenger2: [png, "p2.png"],
      clip_gift: [longWav, "gift.wav"],
      clip_death: [quietWav, "death.wav"],
    });
    expect(r.status).toBe(200);
    expect(r.body.id).toMatch(/^p_/);
    expect(r.body.notes).toEqual(["Clip: gift collected trimmed to 3 s."]);
    const p = r.body.profile;
    expect(p.passengers).toHaveLength(2);
    expect(p.clipDurations).toEqual({ gift: 3, death: 1 });

    const icon = await sharp(path.join(ctx.app.dirs.root, p.icon)).metadata();
    expect([icon.width, icon.height, icon.format]).toEqual([256, 256, "png"]);
    const driver = await sharp(path.join(ctx.app.dirs.root, p.driver)).metadata();
    expect([driver.width, driver.height, driver.format]).toEqual([600, 600, "jpeg"]);

    // Served over HTTP.
    const served = await fetch(base + p.clips.gift);
    expect(served.status).toBe(200);

    // A loud and a very quiet clip end up at about the same loudness.
    const loud = measure(path.join(ctx.app.dirs.root, p.clips.gift));
    const quiet = measure(path.join(ctx.app.dirs.root, p.clips.death));
    expect(Math.abs(loud - -16)).toBeLessThan(2);
    expect(Math.abs(quiet - loud)).toBeLessThan(3);
  }, 30000);

  it("rejects files over the limits with a clear reason", async () => {
    expect(bigPng.length).toBeGreaterThan(1024 * 1024);
    const r = await upload({ teamName: "Falcon", driver: [bigPng, "big.png"] });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("Driver photo is over the 1 MB limit.");

    const r2 = await upload({ teamName: "Falcon", clip_win: [Buffer.alloc(600 * 1024), "win.mp3"] });
    expect(r2.body.error).toBe("Clip: win is 600 KB; the limit is 500 KB.");
  });

  it("rejects wrong file types and unknown fields", async () => {
    const r = await upload({ teamName: "Falcon", icon: [Buffer.from("hello"), "icon.png"] });
    expect(r.body.error).toBe("Icon must be a PNG or JPG image.");
    const r2 = await upload({ teamName: "Falcon", clip_gift: [longWav, "gift.flac"] });
    expect(r2.body.error).toBe("Clip: gift collected must be an MP3, WAV or OGG file.");
    const r3 = await upload({ teamName: "Falcon", selfie: [png, "x.png"] });
    expect(r3.body.error).toMatch(/Unknown upload field "selfie"/);
  });

  it("an undecodable clip is skipped with a note", async () => {
    const r = await upload({ teamName: "Falcon", clip_gift: [Buffer.from("not audio at all"), "gift.mp3"] });
    expect(r.status).toBe(200);
    expect(r.body.notes).toEqual(["Clip: gift collected could not be decoded and was skipped."]);
  });

  it("joining with a profile id shows the files in the host preview", async () => {
    const up = await upload({ teamName: "Falcon", icon: [png, "i.png"], clip_gift: [longWav, "g.wav"] });
    const admin = new TestClient(`ws://localhost:${ctx.app.port}/ws/admin?key=secret`);
    await admin.open();
    const a = new TestClient(`ws://localhost:${ctx.app.port}/agent`);
    await a.open();
    a.send({ type: "join", joinCode: "ABCD", teamName: "Falcon", profile: { id: up.body.id } });
    const s = await admin.wait((m) => m.type === "state" && m.agents[0]?.profile?.icon);
    expect(s.agents[0].profile.icon).toBe(up.body.profile.icon);
    expect(s.agents[0].profileNotes).toEqual(["Clip: gift collected trimmed to 3 s."]);

    const b = new TestClient(`ws://localhost:${ctx.app.port}/agent`);
    await b.open();
    b.send({ type: "join", joinCode: "ABCD", teamName: "Eagle", profile: { id: "p_000000000000" } });
    const s2 = await admin.wait((m) => m.type === "state" && m.agents.find((x: any) => x.team === "Eagle")?.profileNotes.length);
    expect(s2.agents.find((x: any) => x.team === "Eagle").profileNotes).toEqual(["Profile upload not found; using defaults."]);
    [admin, a, b].forEach((c) => c.close());
  });
});
