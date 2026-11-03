import { EventEmitter } from "node:events";
import {
  resolveRules,
  type ActionName,
  type MapFile,
  type MatchStage,
  type RankedStats,
  type Rules,
  type ServerToAgent,
  type ServerToStage,
} from "@lootbot/shared";
import { rankStats, World, type WorldEvent } from "./game/world.js";

export interface MatchTeam {
  carId: string;
  team: string;
}

export interface ReceivedAction {
  carId: string;
  tick: number;
  name: ActionName;
  args: number[];
}

/** Something that changed the world between ticks, other than an action (logged for replays). */
export type WorldOp =
  | { op: "stop"; carId: string }
  | { op: "connected"; carId: string; connected: boolean }
  | { op: "remove"; carId: string };

export interface MatchEvents {
  /** A between-tick change: stop, disconnect/reconnect or kick. */
  op: [op: WorldOp];
  /** A message for one agent. */
  agent: [carId: string, msg: ServerToAgent];
  /** A message for every stage screen. */
  stage: [msg: ServerToStage];
  /** The stage changed. */
  stageChange: [stage: MatchStage];
  /** Fired when Running begins, with the world about to tick. */
  start: [world: World];
  /** After each tick: the actions applied and the events produced. */
  tick: [world: World, actions: ReceivedAction[], events: WorldEvent[]];
  /** The match ended (timer or no gifts) — not fired on abort. */
  end: [world: World, stats: RankedStats[], reason: "time" | "gifts"];
  abort: [];
  pause: [paused: boolean];
}

export interface IntroTiming {
  /** How long each team is shown during the intro. */
  perTeamMs: number;
  /** Length of each step of the 3-2-1 countdown. */
  countdownStepMs: number;
  /** Pause between Finished and Stats. */
  finishedHoldMs: number;
}

const DEFAULT_TIMING: IntroTiming = { perTeamMs: 4000, countdownStepMs: 1000, finishedHoldMs: 3000 };

/**
 * One match: lifecycle stages, the global timer and the tick loop.
 * Transport-free — it emits messages and the server routes them to sockets.
 */
export class Match extends EventEmitter<MatchEvents> {
  stage: MatchStage = "lobby";
  map: MapFile | null = null;
  /** Host overrides applied on top of the map's rules (e.g. match length). */
  overrides: Partial<Rules> = {};
  world: World | null = null;
  lastStats: RankedStats[] | null = null;

  private teams: MatchTeam[] = [];
  private pending = new Map<string, ReceivedAction>();
  private tickTimer: NodeJS.Timeout | null = null;
  private stageTimers: NodeJS.Timeout[] = [];
  private nextTickAt = 0;
  private introStartedAt = 0;
  private timing: IntroTiming;

  constructor(timing: Partial<IntroTiming> = {}) {
    super();
    this.timing = { ...DEFAULT_TIMING, ...timing };
  }

  get rules(): Rules | null {
    return this.map ? resolveRules({ ...(this.map.rules ?? {}), ...this.overrides }) : null;
  }

  // ---------- lobby ----------

  setMap(map: MapFile, overrides: Partial<Rules> = {}) {
    this.requireStage("lobby", "ready");
    this.map = map;
    this.overrides = overrides;
    this.emit("stage", { type: "map", map, rules: this.rules });
  }

  setOverrides(overrides: Partial<Rules>) {
    this.requireStage("lobby", "ready");
    this.overrides = { ...this.overrides, ...overrides };
    this.emit("stage", { type: "map", map: this.map, rules: this.rules });
  }

  toReady() {
    this.requireStage("lobby");
    this.setStage("ready");
  }

  toLobby() {
    this.requireStage("ready", "stats", "finished");
    this.clearStageTimers();
    this.world = null;
    this.setStage("lobby");
  }

  /** Begin the intro with these teams. Cars appear at their spawn points. */
  start(teams: MatchTeam[]) {
    this.requireStage("lobby", "ready");
    if (!this.map) throw new Error("Pick a map first.");
    if (teams.length === 0) throw new Error("No teams to play.");
    if (teams.length > this.map.spawns.length) {
      throw new Error(`Map has ${this.map.spawns.length} spawn points but ${teams.length} teams.`);
    }
    this.world = new World(this.map, this.overrides);
    this.teams = teams;
    this.pending.clear();
    this.lastStats = null;
    for (const t of teams) this.world.addCar(t.carId, t.team);
    this.setStage("intro");
    this.emit("stage", { type: "world", world: this.world.view() });
    this.introStartedAt = Date.now();
    this.emit("stage", this.introMessage()!);

    const introMs = this.timing.perTeamMs * teams.length;
    this.later(introMs, () => this.countdown(3));
  }

  /** The intro message for a stage screen, or null outside the intro. */
  introMessage(): ServerToStage | null {
    if (this.stage !== "intro") return null;
    return {
      type: "intro",
      teams: this.teams.map((t) => t.team),
      perTeamMs: this.timing.perTeamMs,
      elapsedMs: Date.now() - this.introStartedAt,
    };
  }

  /** Skip the rest of the intro and go straight to the countdown. */
  skipIntro() {
    this.requireStage("intro");
    this.clearStageTimers();
    this.countdown(3);
  }

  private countdown(n: number) {
    this.emit("stage", { type: "countdown", value: n });
    if (n === 0) return this.beginRunning();
    this.later(this.timing.countdownStepMs, () => this.countdown(n - 1));
  }

  private beginRunning() {
    const world = this.world!;
    this.setStage("running");
    this.emit("start", world);
    this.broadcastEvent("gameStarted", { timeLeft: world.timeLeft });
    this.sendStates();
    this.scheduleTicks();
  }

  // ---------- running ----------

  pause() {
    this.requireStage("running");
    this.stopTicks();
    this.setStage("paused");
    this.emit("pause", true);
    this.broadcastEvent("gamePaused");
  }

  resume() {
    this.requireStage("paused");
    this.setStage("running");
    this.emit("pause", false);
    this.broadcastEvent("gameResumed");
    this.sendStates();
    this.scheduleTicks();
  }

  /** Stop the match without a result and return to the lobby. */
  abort() {
    if (this.stage === "lobby") return;
    this.stopTicks();
    this.clearStageTimers();
    if (this.world) this.broadcastEvent("gameEnded", { reason: "aborted" });
    this.emit("abort");
    this.world = null;
    this.pending.clear();
    this.setStage("lobby");
  }

  /** An agent's action for the current tick. Late or early actions are ignored. */
  receiveAction(a: ReceivedAction) {
    if (this.stage !== "running" || !this.world) return;
    if (a.tick !== this.world.tick) return;
    this.pending.set(a.carId, a);
  }

  receiveStop(carId: string) {
    if (!this.world || (this.stage !== "running" && this.stage !== "paused")) return;
    const ev = this.world.stop(carId);
    if (ev && ev.kind === "actionResult") {
      this.emit("op", { op: "stop", carId });
      this.emit("agent", carId, { type: "actionResult", tick: this.world.tick, name: ev.name, result: ev.result, stopped: true });
    }
  }

  setConnected(carId: string, connected: boolean) {
    if (this.world?.getCar(carId)) this.emit("op", { op: "connected", carId, connected });
    this.world?.setConnected(carId, connected);
    this.pending.delete(carId);
  }

  /** Remove a car mid-match (kicked). Its gifts go home. */
  removeCar(carId: string) {
    this.teams = this.teams.filter((t) => t.carId !== carId);
    this.pending.delete(carId);
    if (!this.world) return;
    if (this.world.getCar(carId)) this.emit("op", { op: "remove", carId });
    this.world.removeCar(carId);
    if (this.stage === "running" || this.stage === "paused" || this.stage === "intro") {
      this.emit("stage", { type: "world", world: this.world.view() });
    }
  }

  hasCar(carId: string) {
    return this.teams.some((t) => t.carId === carId);
  }

  /** Run one tick. Public so tests can drive the loop by hand. */
  tick() {
    const world = this.world;
    if (!world || this.stage !== "running") return;

    const actions = [...this.pending.values()];
    this.pending.clear();
    for (const a of actions) world.submit(a.carId, a.name, a.args);
    const tickNo = world.tick;
    const events = world.step();

    for (const e of events) {
      if (e.kind === "actionResult") {
        this.emit("agent", e.carId, { type: "actionResult", tick: tickNo, name: e.name, result: e.result });
      } else if (e.kind === "agentEvent") {
        this.emit("agent", e.carId, { type: "event", name: e.name, tick: tickNo, ...(e.data ?? {}) });
      }
    }
    this.emit("tick", world, actions, events);

    const reason = world.tick >= world.matchTicks ? "time" : world.giftsOnMap === 0 ? "gifts" : null;
    this.emit("stage", { type: "world", world: world.view() });
    if (reason) return this.finish(reason);
    this.sendStates();
  }

  private finish(reason: "time" | "gifts") {
    const world = this.world!;
    this.stopTicks();
    this.setStage("finished");
    const stats = rankStats(world.stats());
    this.lastStats = stats;
    this.broadcastEvent("gameEnded", { reason, winner: stats[0]?.team ?? null, scoreboard: world.scoreboard() });
    this.emit("end", world, stats, reason);
    this.later(this.timing.finishedHoldMs, () => {
      this.setStage("stats");
      this.emit("stage", { type: "stats", stats, winner: stats[0]?.team ?? null });
    });
  }

  // ---------- helpers ----------

  private sendStates() {
    const world = this.world!;
    for (const t of this.teams) {
      const s = world.agentState(t.carId);
      if (s) this.emit("agent", t.carId, { type: "state", ...s });
    }
  }

  private broadcastEvent(name: "gameStarted" | "gamePaused" | "gameResumed" | "gameEnded", data: Record<string, unknown> = {}) {
    const tick = this.world?.tick ?? 0;
    for (const t of this.teams) this.emit("agent", t.carId, { type: "event", name, tick, ...data });
  }

  /** Fixed-rate loop that corrects for drift so the clock matches real time. */
  private scheduleTicks() {
    const interval = 1000 / this.world!.rules.tickRate;
    this.nextTickAt = Date.now() + interval;
    const loop = () => {
      this.tick();
      if (this.stage !== "running") return;
      this.nextTickAt += interval;
      this.tickTimer = setTimeout(loop, Math.max(0, this.nextTickAt - Date.now()));
    };
    this.tickTimer = setTimeout(loop, interval);
  }

  private stopTicks() {
    if (this.tickTimer) clearTimeout(this.tickTimer);
    this.tickTimer = null;
  }

  private later(ms: number, fn: () => void) {
    this.stageTimers.push(setTimeout(fn, ms));
  }

  private clearStageTimers() {
    this.stageTimers.forEach(clearTimeout);
    this.stageTimers = [];
  }

  private setStage(stage: MatchStage) {
    this.stage = stage;
    this.emit("stageChange", stage);
    this.emit("stage", { type: "stage", stage });
  }

  private requireStage(...allowed: MatchStage[]) {
    if (!allowed.includes(this.stage)) {
      throw new Error(`Not allowed during ${this.stage} (needs ${allowed.join(" or ")}).`);
    }
  }
}
