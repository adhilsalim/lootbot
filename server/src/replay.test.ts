import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { wanderBot } from "./game/bots.js";
import { World } from "./game/world.js";
import { FakeAgent, startTestApp, TestClient } from "./testUtil.js";

describe("replays", () => {
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

  async function playMatch(seconds: number) {
    for (const [i, team] of ["Falcon", "Eagle"].entries()) {
      const a = new FakeAgent(`${ctx.url}/agent`);
      clients.push(a);
      const bot = wanderBot(i + 11);
      a.brain = (s) => {
        const act = bot(s);
        return act?.name === "collectGift" ? { name: "turn", args: [90] } : act;
      };
      await a.open();
      a.send({ type: "join", joinCode: "ABCD", teamName: team });
      await a.wait((m) => m.type === "joinResult");
      admin.send({ type: "accept", id: [...ctx.app.lobby.agents.values()].find((x) => x.team === team)!.id });
      await a.wait((m) => m.type === "joinResult" && m.accepted);
    }
    admin.send({ type: "selectMap", file: "test-room.json" });
    admin.send({ type: "setRules", rules: { matchSeconds: seconds } });
    admin.send({ type: "start", override: true });
    await admin.wait((m) => m.type === "state" && m.stage === "stats", 15000);
    return readdirSync(ctx.app.dirs.matches)[0];
  }

  it("plays a saved match back on the stage, seeks, and ends on the stats", async () => {
    const name = await playMatch(4);
    const dir = path.join(ctx.app.dirs.matches, name);
    const meta = JSON.parse(readFileSync(path.join(dir, "match.json"), "utf8"));

    const stage = new TestClient(`ws://localhost:${ctx.app.port}/ws/stage`);
    clients.push(stage);
    await stage.open();
    admin.send({ type: "replay", name });
    const status = await stage.wait((m) => m.type === "replay" && m.active);
    expect(status).toMatchObject({ name, tick: 0, totalTicks: meta.totalTicks, playing: false });
    expect(await stage.wait((m) => m.type === "profiles")).toMatchObject({ profiles: [{ team: "Falcon" }, { team: "Eagle" }] });

    // Seek to the middle: the frame matches the snapshot at that tick.
    admin.send({ type: "replayControl", action: "seek", value: 40 });
    const frame = await stage.next((m) => m.type === "world" && m.world.tick === 40);
    const w = new World(meta.map, meta.rules);
    expect(frame.world.cars).toHaveLength(2);
    // Seeking back to the same tick gives the same frame.
    admin.send({ type: "replayControl", action: "seek", value: 10 });
    await stage.next((m) => m.type === "world" && m.world.tick === 10);
    admin.send({ type: "replayControl", action: "seek", value: 40 });
    const again = await stage.next((m) => m.type === "world" && m.world.tick === 40);
    expect(again.world.cars).toEqual(frame.world.cars);

    // Play to the end at 2× and compare the last frame with the final snapshot.
    admin.send({ type: "replayControl", action: "speed", value: 2 });
    admin.send({ type: "replayControl", action: "play" });
    const stats = await stage.next((m) => m.type === "stats", 10000);
    expect(stats.stats).toEqual(meta.result);
    const last = [...stage.msgs].reverse().find((m) => m.type === "world");
    expect(last.world.tick).toBe(meta.totalTicks);
    w.restore(JSON.parse(readFileSync(path.join(dir, `snapshots/${meta.totalTicks}.json`), "utf8")));
    const strip = (v: any) => ({ cars: v.cars, items: v.items });
    expect(strip(last.world)).toEqual(strip(w.view()));

    // Stopping hands the stage back to the live match.
    const before = stage.msgs.length;
    admin.send({ type: "replayControl", action: "stop" });
    expect(await stage.wait((m) => m.type === "replay", 3000, before)).toEqual({ type: "replay", active: false });
    expect(await stage.wait((m) => m.type === "stage", 3000, before)).toMatchObject({ stage: "stats" });
  }, 30000);

  it("refuses replays while a match is running", async () => {
    await playMatch(2);
    const name = readdirSync(ctx.app.dirs.matches)[0];
    admin.send({ type: "toLobby" });
    admin.send({ type: "start", override: true });
    await admin.wait((m) => m.type === "state" && m.stage === "intro");
    admin.send({ type: "replay", name });
    expect(await admin.wait((m) => m.type === "error")).toMatchObject({ message: /between matches/ });
  }, 30000);
});
