import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AudioEntry, MapFile, MatchSummary, RankedStats, Rules, TeamProfileView } from "@lootbot/shared";
import type { Match, ReceivedAction, WorldOp } from "./match.js";
import type { World } from "./game/world.js";

export type LogOp = WorldOp;

/** One line of `ticks.jsonl`. */
export type TickLine =
  | { t: "tick"; tick: number; ops?: LogOp[]; actions: Omit<ReceivedAction, "tick">[]; events: unknown[] }
  | { t: "audio"; tick: number; entry: AudioEntry };

export interface MatchMeta {
  name: string;
  map: MapFile;
  rules: Rules;
  teams: { carId: string; team: string; profile: TeamProfileView | null }[];
  startedAt: string;
  endedAt: string | null;
  /** "time" | "gifts" | "aborted" | null while running. */
  endReason: string | null;
  totalTicks: number | null;
  result: RankedStats[] | null;
}

const pad = (n: number) => String(n).padStart(2, "0");
function folderName(mapName: string, d = new Date()) {
  const slug = mapName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "map";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}-${slug}`;
}

/**
 * Saves every match to `matches/<date>-<map>/` as it runs:
 * `match.json` (setup and result), `ticks.jsonl` (one line per tick) and
 * `snapshots/<tick>.json` (full world every 5 seconds).
 */
export class MatchLogger {
  private stream: WriteStream | null = null;
  private dir: string | null = null;
  private meta: MatchMeta | null = null;
  private ops: LogOp[] = [];
  private snapshotEvery = 50;
  /** Folder name of the match being recorded (or the last one). */
  current: string | null = null;
  /** Set to false for built-in test runs. */
  enabled = true;

  constructor(private root: string, match: Match, private profileOf: (team: string) => TeamProfileView | null) {
    match.on("start", (world) => this.start(world));
    match.on("tick", (world, actions, events) => this.tick(world, actions, events));
    match.on("end", (world, stats, reason) => this.finish(world, stats, reason));
    match.on("abort", () => this.finish(match.world, null, "aborted"));
    match.on("op", (op) => this.op(op));
  }

  private async start(world: World) {
    if (!this.enabled) return;
    const name = folderName(world.map.name);
    this.dir = path.join(this.root, name);
    this.current = name;
    await mkdir(path.join(this.dir, "snapshots"), { recursive: true });
    this.snapshotEvery = world.rules.tickRate * 5;
    this.meta = {
      name,
      map: world.map,
      rules: world.rules,
      teams: world.allCars().map((c) => ({ carId: c.id, team: c.team, profile: this.profileOf(c.team) })),
      startedAt: new Date().toISOString(),
      endedAt: null,
      endReason: null,
      totalTicks: null,
      result: null,
    };
    await this.writeMeta();
    this.stream = createWriteStream(path.join(this.dir, "ticks.jsonl"), { flags: "a" });
    await this.snapshot(world);
  }

  /** Record a stop, disconnect or kick; written with the next tick so replays apply it in order. */
  private op(op: LogOp) {
    if (this.stream) this.ops.push(op);
  }

  audio(tick: number, entry: AudioEntry) {
    this.write({ t: "audio", tick, entry });
  }

  private tick(world: World, actions: ReceivedAction[], events: unknown[]) {
    if (!this.stream) return;
    const line: TickLine = {
      t: "tick",
      tick: world.tick - 1,
      actions: actions.map(({ carId, name, args }) => ({ carId, name, args })),
      events,
    };
    if (this.ops.length) line.ops = this.ops.splice(0);
    this.write(line);
    if (world.tick % this.snapshotEvery === 0) void this.snapshot(world);
  }

  private write(line: TickLine) {
    this.stream?.write(JSON.stringify(line) + "\n");
  }

  private async snapshot(world: World) {
    if (!this.dir) return;
    await writeFile(path.join(this.dir, "snapshots", `${world.tick}.json`), JSON.stringify(world.snapshot()));
  }

  private async finish(world: World | null, stats: RankedStats[] | null, reason: string) {
    if (!this.meta || !this.stream) return;
    const stream = this.stream;
    this.stream = null;
    if (this.ops.length && world) this.write({ t: "tick", tick: world.tick, ops: this.ops.splice(0), actions: [], events: [] });
    this.ops = [];
    await new Promise<void>((r) => stream.end(r));
    if (world) await this.snapshot(world);
    Object.assign(this.meta, {
      endedAt: new Date().toISOString(),
      endReason: reason,
      totalTicks: world?.tick ?? null,
      result: stats,
    });
    await this.writeMeta();
    this.meta = null;
  }

  private writeMeta() {
    return writeFile(path.join(this.dir!, "match.json"), JSON.stringify(this.meta, null, 2));
  }
}

/** Saved matches, newest first. */
export async function listMatches(root: string): Promise<MatchSummary[]> {
  await mkdir(root, { recursive: true });
  const out: MatchSummary[] = [];
  for (const name of (await readdir(root)).sort().reverse()) {
    try {
      const m = await loadMeta(root, name);
      out.push({
        name,
        map: m.map.name,
        startedAt: m.startedAt,
        endReason: m.endReason,
        totalTicks: m.totalTicks,
        teams: m.teams.map((t) => t.team),
        winner: m.result?.[0]?.team ?? null,
      });
    } catch {
      // Not a match folder.
    }
  }
  return out;
}

export async function loadMeta(root: string, name: string): Promise<MatchMeta> {
  return JSON.parse(await readFile(path.join(root, path.basename(name), "match.json"), "utf8"));
}

const CSV_COLUMNS: [keyof RankedStats | "accuracyPct", string][] = [
  ["rank", "Rank"],
  ["team", "Team"],
  ["gifts", "Gifts"],
  ["deaths", "Deaths"],
  ["hitsLanded", "Hits landed"],
  ["hitsTaken", "Hits taken"],
  ["shotsFired", "Shots fired"],
  ["accuracyPct", "Accuracy %"],
  ["kills", "Kills"],
  ["giftsLost", "Gifts lost"],
  ["pickups", "Pickups"],
  ["distance", "Distance"],
  ["lifeLeft", "Life left"],
];

export function statsCsv(stats: RankedStats[]) {
  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = stats.map((s) =>
    CSV_COLUMNS.map(([k]) => (k === "accuracyPct" ? Math.round(s.accuracy * 100) : k === "distance" ? Math.round(s.distance * 10) / 10 : s[k])).map(esc).join(","),
  );
  return [CSV_COLUMNS.map(([, h]) => h).join(","), ...rows].join("\n") + "\n";
}
