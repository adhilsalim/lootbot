import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { AudioEntry, ReplayStatus, ServerToStage } from "@lootbot/shared";
import { World } from "./game/world.js";
import { loadMeta, type MatchMeta, type TickLine } from "./matchLog.js";
import { colorFor } from "./teamColors.js";

type TickRecord = Extract<TickLine, { t: "tick" }>;


/**
 * Plays a saved match back on the stage by re-simulating the world from the nearest
 * snapshot with the logged actions. The world is deterministic, so this reproduces
 * the match exactly, including the audio entries at the ticks they played.
 */
export class ReplayPlayer {
  meta!: MatchMeta;
  private world!: World;
  private lines = new Map<number, TickRecord>();
  private audio = new Map<number, AudioEntry[]>();
  private snapshots: number[] = [];
  private dir!: string;
  private timer: NodeJS.Timeout | null = null;
  private totalTicks = 0;
  playing = false;
  speed = 1;

  constructor(private root: string, private send: (msg: ServerToStage) => void, private onChange: () => void) {}

  async load(name: string) {
    this.stopTimer();
    this.dir = path.join(this.root, path.basename(name));
    this.meta = await loadMeta(this.root, name);
    this.lines.clear();
    this.audio.clear();
    const raw = await readFile(path.join(this.dir, "ticks.jsonl"), "utf8");
    let last = 0;
    for (const l of raw.split("\n")) {
      if (!l.trim()) continue;
      const line: TickLine = JSON.parse(l);
      if (line.t === "tick") {
        this.lines.set(line.tick, line);
        last = Math.max(last, line.tick + 1);
      } else {
        const list = this.audio.get(line.tick) ?? [];
        list.push(line.entry);
        this.audio.set(line.tick, list);
      }
    }
    this.totalTicks = this.meta.totalTicks ?? last;
    this.snapshots = (await readdir(path.join(this.dir, "snapshots")))
      .map((f) => Number(f.replace(".json", "")))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
    if (!this.snapshots.includes(0)) throw new Error("This match has no starting snapshot.");

    this.world = new World(this.meta.map, this.meta.rules);
    this.sendSetup(this.send);
    await this.seek(0);
  }

  /** Map, teams and current frame, for the stage (also used when a stage screen connects mid-replay). */
  sendSetup(send: (msg: ServerToStage) => void) {
    send({ type: "map", map: this.meta.map, rules: this.meta.rules });
    send({
      type: "profiles",
      profiles: this.meta.teams.map((t, i) => t.profile ?? { team: t.team, icon: null, driver: null, passengers: [], clips: {}, color: colorFor(i) }),
    });
    send({ type: "stage", stage: "running" });
    if (this.world.tick > 0) send({ type: "world", world: this.world.view() });
    const st = this.status;
    if (st) send({ type: "replay", active: true, name: st.name, totalTicks: st.totalTicks, tick: st.tick, speed: st.speed, playing: st.playing });
  }

  get status(): ReplayStatus | null {
    if (!this.meta) return null;
    return { name: this.meta.name, tick: this.world.tick, totalTicks: this.totalTicks, playing: this.playing, speed: this.speed };
  }

  /** Jump to any tick: restore the snapshot just before it, then re-simulate forward. */
  async seek(tick: number) {
    const target = Math.max(0, Math.min(this.totalTicks, Math.round(tick)));
    const snap = [...this.snapshots].reverse().find((s) => s <= target) ?? 0;
    this.world.restore(JSON.parse(await readFile(path.join(this.dir, "snapshots", `${snap}.json`), "utf8")));
    while (this.world.tick < target) this.apply();
    this.send({ type: "audioClear" });
    this.send({ type: "world", world: this.world.view() });
    this.publish();
    if (target >= this.totalTicks) this.end();
  }

  play() {
    if (this.world.tick >= this.totalTicks) return;
    this.playing = true;
    this.send({ type: "stage", stage: "running" });
    this.schedule();
    this.publish();
  }

  pause() {
    this.playing = false;
    this.stopTimer();
    this.publish();
  }

  setSpeed(speed: number) {
    this.speed = speed === 2 ? 2 : 1;
    if (this.playing) this.schedule();
    this.publish();
  }

  stop() {
    this.playing = false;
    this.stopTimer();
    this.send({ type: "audioClear" });
    this.send({ type: "replay", active: false });
  }

  /** Apply one logged tick to the world. */
  private apply() {
    const line = this.lines.get(this.world.tick);
    for (const op of line?.ops ?? []) {
      if (op.op === "stop") this.world.stop(op.carId);
      else if (op.op === "connected") this.world.setConnected(op.carId, op.connected);
      else if (op.op === "remove") this.world.removeCar(op.carId);
    }
    for (const a of line?.actions ?? []) this.world.submit(a.carId, a.name, a.args);
    this.world.step();
  }

  private stepOnce() {
    this.apply();
    this.send({ type: "world", world: this.world.view() });
    for (const entry of this.audio.get(this.world.tick) ?? []) this.send({ type: "audioPlay", entry });
    if (this.world.tick % this.meta.rules.tickRate === 0) this.publish();
    if (this.world.tick >= this.totalTicks) this.end();
  }

  private end() {
    this.pause();
    if (this.meta.result) {
      this.send({ type: "stage", stage: "stats" });
      this.send({ type: "stats", stats: this.meta.result, winner: this.meta.result[0]?.team ?? null });
    }
  }

  private schedule() {
    this.stopTimer();
    const interval = 1000 / (this.meta.rules.tickRate * this.speed);
    this.timer = setInterval(() => this.stepOnce(), interval);
  }

  private stopTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private publish() {
    const s = this.status!;
    this.send({ type: "replay", active: true, name: s.name, totalTicks: s.totalTicks, tick: s.tick, speed: s.speed, playing: s.playing });
    this.onChange();
  }
}
