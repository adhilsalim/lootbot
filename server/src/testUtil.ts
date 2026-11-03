import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import type { MapFile } from "@lootbot/shared";
import { createApp, type AppOptions } from "./app.js";

export const testMap: MapFile = {
  name: "Test Room",
  width: 10,
  height: 7,
  walls: [],
  gifts: [{ id: "g1", home: [4, 3] }, { id: "g2", home: [5, 1] }],
  ammo: [],
  energy: [],
  spawns: [[2, 3], [7, 3], [2, 5], [7, 5]],
  rules: { matchSeconds: 30, tickRate: 20 },
};

/** Start a real server on a random port with a temp data folder. */
export async function startTestApp(extra: Partial<AppOptions> = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "lootbot-"));
  for (const d of ["maps", "matches", "uploads"]) mkdirSync(path.join(root, d));
  writeFileSync(path.join(root, "maps/test-room.json"), JSON.stringify(testMap));
  const app = await createApp({
    port: 0,
    rootDir: root,
    joinCode: "ABCD",
    adminKey: "secret",
    timing: { perTeamMs: 10, countdownStepMs: 5, finishedHoldMs: 10 },
    test: { pings: 5, replyTimeoutMs: 300, amberMs: 100, tickWindowMs: 100 },
    pingEveryMs: 0,
    ...extra,
  });
  return { app, root, url: `ws://localhost:${app.port}` };
}

/** A WebSocket client that records every message and can wait for one matching a predicate. */
export class TestClient {
  ws: WebSocket;
  msgs: any[] = [];
  closed = false;
  private waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      this.msgs.push(m);
      this.waiters = this.waiters.filter((w) => (w.pred(m) ? (w.resolve(m), false) : true));
    });
    this.ws.on("close", () => (this.closed = true));
  }

  open() {
    return new Promise<void>((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve();
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
  }

  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }

  /** Resolve with the first message (already received or future) that matches. */
  wait(pred: (m: any) => boolean, ms = 3000, fromIndex = 0): Promise<any> {
    const hit = this.msgs.slice(fromIndex).find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`Timed out waiting; last: ${JSON.stringify(this.msgs.at(-1))}`)), ms);
      this.waiters.push({ pred, resolve: (m) => (clearTimeout(t), resolve(m)) });
    });
  }

  /** Wait for a future message only. */
  next(pred: (m: any) => boolean, ms = 3000) {
    return this.wait(pred, ms, this.msgs.length);
  }

  waitClosed(ms = 2000) {
    return new Promise<void>((resolve, reject) => {
      if (this.closed) return resolve();
      const t = setTimeout(() => reject(new Error("not closed")), ms);
      this.ws.once("close", () => (clearTimeout(t), resolve()));
    });
  }

  close() {
    this.ws.close();
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A fake agent that behaves like the starter kit: answers pings, follows test requests
 * in the practice room, and calls `brain` for real states. `delayMs` slows every reply.
 */
export class FakeAgent extends TestClient {
  token: string | null = null;
  delayMs = 0;
  silent = false;
  brain: (s: any) => { name: string; args: number[] } | null = () => null;
  private testRequest: { name: string; args: number[] } | null = null;

  constructor(url: string) {
    super(url);
    this.ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (this.silent) return;
      const reply = (msg: unknown) => (this.delayMs ? setTimeout(() => this.send(msg), this.delayMs) : this.send(msg));
      if (m.type === "joinResult" && m.token) this.token = m.token;
      if (m.type === "ping") reply({ type: "pong", id: m.id });
      if (m.type === "testRequest") this.testRequest = { name: m.name, args: m.args };
      if (m.type === "state") {
        let a: { name: string; args: number[] } | null;
        if (m.practice) {
          a = this.testRequest ?? { name: "idle", args: [1] };
          this.testRequest = null;
        } else {
          a = this.brain(m);
        }
        if (a) reply({ type: "action", token: this.token, tick: m.tick, ...a });
      }
    });
  }
}
