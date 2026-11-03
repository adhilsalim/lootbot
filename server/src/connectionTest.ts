import type { ActionMsg, ActionName, AgentToServer, ConnectionTestResult, MapFile } from "@lootbot/shared";
import { World } from "./game/world.js";
import type { AgentRecord, Lobby } from "./lobby.js";

export interface TestOptions {
  pings: number;
  /** Max wait for one reply before counting it as lost. */
  replyTimeoutMs: number;
  /** Delay above which an agent is flagged amber. */
  amberMs: number;
  /** Tick window the practice reply must fit in. */
  tickWindowMs: number;
}

const DEFAULTS: TestOptions = { pings: 20, replyTimeoutMs: 1000, amberMs: 100, tickWindowMs: 100 };

/** 5×5 practice room: the car starts at (2,2) facing north; a gift waits at (3,2). */
const PRACTICE_MAP: MapFile = {
  name: "Practice",
  width: 5,
  height: 5,
  walls: [],
  gifts: [{ id: "p1", home: [3, 2] }],
  ammo: [],
  energy: [],
  spawns: [[2, 2]],
  rules: { startAmmo: 3, matchSeconds: 60 },
};

/** The dry run: each step must come back from the agent as the matching action. */
const DRY_RUN: { name: ActionName; args: number[] }[] = [
  { name: "turn", args: [90] },
  { name: "move", args: [1] },
  { name: "fire", args: [] },
  { name: "collectGift", args: [] },
];

/**
 * Runs the automatic connection test for an agent: pings, a practice state that must be answered within the tick window,
 * and a dry run of turn, move, fire and collect in a hidden practice room.
 */
export class ConnectionTester {
  private waiters = new Map<string, { pred: (m: AgentToServer) => boolean; resolve: (m: AgentToServer | null) => void }[]>();
  private pingId = 1;
  private opts: TestOptions;
  /** Most recent round-trip time per agent from background pings. */
  readonly latency = new Map<string, number>();

  constructor(private lobby: Lobby, opts: Partial<TestOptions> = {}, private onChange: () => void = () => {}) {
    this.opts = { ...DEFAULTS, ...opts };
    lobby.on("agentMessage", (agent, msg) => {
      const list = this.waiters.get(agent.id);
      if (!list) return;
      const i = list.findIndex((w) => w.pred(msg));
      if (i !== -1) list.splice(i, 1)[0].resolve(msg);
    });
  }

  setTickWindow(ms: number) {
    this.opts.tickWindowMs = ms;
  }

  /** Wait for a matching message from the agent, or null after the timeout. */
  private waitFor(agent: AgentRecord, pred: (m: AgentToServer) => boolean, ms = this.opts.replyTimeoutMs) {
    return new Promise<AgentToServer | null>((resolve) => {
      const list = this.waiters.get(agent.id) ?? [];
      this.waiters.set(agent.id, list);
      const w = {
        pred,
        resolve: (m: AgentToServer | null) => {
          clearTimeout(t);
          resolve(m);
        },
      };
      const t = setTimeout(() => {
        list.splice(list.indexOf(w), 1);
        resolve(null);
      }, ms);
      list.push(w);
    });
  }

  /** Send one ping and return the round-trip time in ms, or null if lost. */
  async ping(agent: AgentRecord) {
    const id = this.pingId++;
    const start = performance.now();
    const reply = this.waitFor(agent, (m) => m.type === "pong" && m.id === id);
    this.lobby.send(agent, { type: "ping", id });
    return (await reply) ? Math.round((performance.now() - start) * 10) / 10 : null;
  }

  async run(agent: AgentRecord): Promise<ConnectionTestResult> {
    const detail: string[] = [];
    const set = (r: Partial<ConnectionTestResult>) => {
      agent.test = { ...agent.test, ...r };
      this.onChange();
    };
    set({ status: "running", avgMs: null, maxMs: null, detail: ["testing…"] });
    let failed = false;

    // 1. Pings.
    const rtts: number[] = [];
    for (let i = 0; i < this.opts.pings && agent.ws; i++) {
      const rtt = await this.ping(agent);
      if (rtt !== null) rtts.push(rtt);
    }
    const lost = this.opts.pings - rtts.length;
    const avg = rtts.length ? Math.round((rtts.reduce((a, b) => a + b, 0) / rtts.length) * 10) / 10 : null;
    const max = rtts.length ? Math.max(...rtts) : null;
    if (rtts.length < this.opts.pings / 2) {
      failed = true;
      detail.push(`ping: ${lost}/${this.opts.pings} lost`);
    } else {
      detail.push(lost ? `ping ok (${lost} lost)` : "ping ok");
    }
    set({ avgMs: avg, maxMs: max });

    // 2 + 3. Practice state reply and dry run, in a private world.
    let slowReply = false;
    if (!failed && agent.ws) {
      this.lobby.practice.add(agent.id);
      try {
        const world = new World(PRACTICE_MAP);
        world.addCar(agent.id, agent.team);
        world.getCar(agent.id)!.heading = 0;

        const sendState = () => {
          const s = world.agentState(agent.id)!;
          this.lobby.send(agent, { type: "state", practice: true, ...s });
          return s.tick;
        };
        const isAction = (tick: number, name?: ActionName) => (m: AgentToServer) =>
          m.type === "action" && m.tick === tick && (!name || m.name === name);

        // A practice state must be answered (any action) within the tick window.
        const t0 = performance.now();
        const tick = sendState();
        const reply = await this.waitFor(agent, isAction(tick));
        const ms = performance.now() - t0;
        if (!reply) {
          failed = true;
          detail.push("practice state: no reply");
        } else {
          slowReply = ms > this.opts.tickWindowMs;
          detail.push(slowReply ? `practice reply slow (${Math.round(ms)} ms)` : "practice reply ok");
        }

        // Dry run each action end to end.
        for (const step of failed ? [] : DRY_RUN) {
          const tick = world.tick;
          this.lobby.send(agent, { type: "testRequest", name: step.name, args: step.args });
          sendState();
          const m = (await this.waitFor(agent, isAction(tick, step.name))) as ActionMsg | null;
          if (!m) {
            failed = true;
            detail.push(`${step.name}: no reply`);
            break;
          }
          world.submit(agent.id, m.name, m.args);
          let result = null;
          for (let i = 0; i < 50 && !result; i++) {
            const ev = world.step().find((e) => e.kind === "actionResult" && e.carId === agent.id);
            if (ev && ev.kind === "actionResult") result = ev.result;
          }
          this.lobby.send(agent, { type: "actionResult", tick, name: m.name, result: result!, practice: true });
          detail.push(`${step.name} ok`);
        }
      } finally {
        this.lobby.practice.delete(agent.id);
      }
    }

    const status = failed || !agent.ws ? "red" : slowReply || (avg ?? 0) > this.opts.amberMs ? "amber" : "green";
    if (!agent.ws && !failed) detail.push("disconnected during test");
    const result: ConnectionTestResult = { status, avgMs: avg, maxMs: max, detail };
    set(result);
    return result;
  }

  /** Ping every connected accepted agent (background latency monitor). */
  async pingAll() {
    await Promise.all(
      this.lobby.accepted().filter((a) => a.ws && !this.lobby.practice.has(a.id)).map(async (a) => {
        const rtt = await this.ping(a);
        if (rtt !== null) this.latency.set(a.id, rtt);
        else this.latency.delete(a.id);
      }),
    );
    this.onChange();
  }
}
