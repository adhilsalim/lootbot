import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { wanderBot } from "./game/bots.js";
import { World } from "./game/world.js";
import { FakeAgent, sleep, startTestApp, TestClient } from "./testUtil.js";
import type { TickLine } from "./matchLog.js";

describe("match log", () => {
  let ctx: Awaited<ReturnType<typeof startTestApp>>;
  let admin: TestClient;
  const clients: TestClient[] = [];

  beforeEach(async () => {
    ctx = await startTestApp();
    admin = new TestClient(`ws://localhost:${ctx.app.port}/ws/admin?key=secret`);
    clients.push(admin);
    await admin.open();
  });
  afterEach(async () => {
    clients.splice(0).forEach((c) => c.close());
    await ctx.app.close();
  });

  async function playShortMatch() {
    const agents: FakeAgent[] = [];
    for (const [i, team] of ["Falcon", "Eagle"].entries()) {
      const a = new FakeAgent(`${ctx.url}/agent`);
      clients.push(a);
      const bot = wanderBot(i + 7);
      // Never pick up gifts, so the match runs until the timer ends.
      a.brain = (s) => {
        const act = bot(s);
        return act?.name === "collectGift" ? { name: "turn", args: [90] } : act;
      };
      await a.open();
      a.send({ type: "join", joinCode: "ABCD", teamName: team });
      await a.wait((m) => m.type === "joinResult");
      admin.send({ type: "accept", id: [...ctx.app.lobby.agents.values()].find((x) => x.team === team)!.id });
      await a.wait((m) => m.type === "joinResult" && m.accepted);
      agents.push(a);
    }
    admin.send({ type: "selectMap", file: "test-room.json" });
    admin.send({ type: "setRules", rules: { matchSeconds: 6 } });
    admin.send({ type: "start", override: true });
    // Disconnect one agent briefly mid-match so ops are logged too.
    await agents[1].wait((m) => m.type === "state" && m.tick === 20, 5000);
    agents[1].close();
    await admin.wait((m) => m.type === "state" && m.stage === "stats", 15000);
    await sleep(100);
  }

  it("writes match.json, ticks.jsonl and snapshots, and replays deterministically", async () => {
    await playShortMatch();
    const dirs = readdirSync(ctx.app.dirs.matches);
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-test-room$/);
    const dir = path.join(ctx.app.dirs.matches, dirs[0]);

    const meta = JSON.parse(readFileSync(path.join(dir, "match.json"), "utf8"));
    expect(meta).toMatchObject({ endReason: "time", teams: [{ team: "Falcon" }, { team: "Eagle" }] });
    expect(meta.result).toHaveLength(2);
    expect(meta.result[0].rank).toBe(1);

    const lines: TickLine[] = readFileSync(path.join(dir, "ticks.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const ticks = lines.filter((l) => l.t === "tick");
    expect(ticks[0].tick).toBe(0);
    expect(ticks.length).toBe(meta.totalTicks);
    expect(ticks.some((l) => l.t === "tick" && l.ops?.some((o) => o.op === "connected"))).toBe(true);

    const snaps = readdirSync(path.join(dir, "snapshots")).map((f) => Number(f.replace(".json", ""))).sort((a, b) => a - b);
    expect(snaps.slice(0, 2)).toEqual([0, 100]); // tickRate 20 → every 100 ticks
    expect(snaps.at(-1)).toBe(meta.totalTicks);

    // Re-simulate from snapshot 0 using only the log, and compare with the final snapshot.
    const world = new World(meta.map, meta.rules);
    world.restore(JSON.parse(readFileSync(path.join(dir, "snapshots/0.json"), "utf8")));
    for (const l of ticks) {
      if (l.t !== "tick") continue;
      for (const op of l.ops ?? []) {
        if (op.op === "stop") world.stop(op.carId);
        if (op.op === "connected") world.setConnected(op.carId, op.connected);
        if (op.op === "remove") world.removeCar(op.carId);
      }
      for (const a of l.actions) world.submit(a.carId, a.name, a.args);
      world.step();
    }
    const final = JSON.parse(readFileSync(path.join(dir, `snapshots/${meta.totalTicks}.json`), "utf8"));
    expect(JSON.parse(JSON.stringify(world.snapshot()))).toEqual(final);
  }, 30000);

  it("exports the stats as CSV", async () => {
    await playShortMatch();
    const res = await fetch(`http://localhost:${ctx.app.port}/api/admin/stats.csv`, { headers: { "x-admin-key": "secret" } });
    const csv = await res.text();
    const rows = csv.trim().split("\n");
    expect(rows[0]).toBe("Rank,Team,Gifts,Deaths,Hits landed,Hits taken,Shots fired,Accuracy %,Kills,Gifts lost,Pickups,Distance,Life left");
    expect(rows).toHaveLength(3);
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename=".*test-room-stats.csv"/);

    const list = await (await fetch(`http://localhost:${ctx.app.port}/api/admin/matches`, { headers: { "x-admin-key": "secret" } })).json();
    expect(list[0]).toMatchObject({ map: "Test Room", teams: ["Falcon", "Eagle"] });
  }, 30000);
});
