import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAgent, startTestApp, TestClient } from "./testUtil.js";

describe("connection test", () => {
  let ctx: Awaited<ReturnType<typeof startTestApp>>;
  let admin: TestClient;
  const clients: TestClient[] = [];

  beforeEach(async () => {
    ctx = await startTestApp();
    admin = new TestClient(`${ctx.url}/ws/admin?key=secret`);
    clients.push(admin);
    await admin.open();
  });
  afterEach(async () => {
    clients.splice(0).forEach((c) => c.close());
    await ctx.app.close();
  });

  /** Join with a fake agent and accept it; the test starts automatically. */
  async function joinAgent(team: string, setup: (a: FakeAgent) => void = () => {}) {
    const a = new FakeAgent(`${ctx.url}/agent`);
    clients.push(a);
    setup(a);
    await a.open();
    a.send({ type: "join", joinCode: "ABCD", teamName: team });
    await a.wait((m) => m.type === "joinResult");
    const id = [...ctx.app.lobby.agents.values()].find((x) => x.team === team)!.id;
    admin.send({ type: "accept", id });
    return { a, id };
  }
  const waitTest = (team: string, pred: (t: any) => boolean = (t) => !["running", "untested"].includes(t.status)) =>
    admin.wait((m) => m.type === "state" && m.agents.some((x: any) => x.team === team && pred(x.test)), 8000).then(
      (m) => m.agents.find((x: any) => x.team === team).test,
    );

  it("a well-behaved agent goes green after the dry run", async () => {
    const { a } = await joinAgent("Falcon");
    const t = await waitTest("Falcon");
    expect(t.status).toBe("green");
    expect(t.avgMs).toBeLessThan(100);
    expect(t.detail).toEqual(["ping ok", "practice reply ok", "turn ok", "move ok", "fire ok", "collectGift ok"]);
    // The agent saw practice results for each dry-run action.
    const results = a.msgs.filter((m) => m.type === "actionResult" && m.practice);
    expect(results.map((r) => r.name)).toEqual(["turn", "move", "fire", "collectGift"]);
    expect(results[0].result).toEqual({ heading: 90 });
    expect(results[3].result).toBe("ok");
  });

  it("a slow agent is amber", async () => {
    await joinAgent("Slow", (a) => (a.delayMs = 150));
    expect((await waitTest("Slow")).status).toBe("amber");
  });

  it("a silent agent is red", async () => {
    await joinAgent("Mute", (a) => (a.silent = true));
    const t = await waitTest("Mute");
    expect(t.status).toBe("red");
    expect(t.detail[0]).toMatch(/lost/);
  });

  it("an agent that ignores test requests fails the dry run", async () => {
    const { a } = await joinAgent("Lazy");
    await a.wait((m) => m.type === "joinResult" && m.accepted);
    // Override: reply to practice states with idle only.
    a.ws.removeAllListeners("message");
    a.ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === "ping") a.send({ type: "pong", id: m.id });
      if (m.type === "state") a.send({ type: "action", token: a.token, tick: m.tick, name: "idle", args: [1] });
    });
    const t = await waitTest("Lazy");
    expect(t.status).toBe("red");
    expect(t.detail).toContain("turn: no reply");
  });

  it("start is allowed once every team passed, and practice traffic stays out of the match", async () => {
    const { a } = await joinAgent("Falcon");
    await waitTest("Falcon");
    admin.send({ type: "selectMap", file: "test-room.json" });
    admin.send({ type: "toReady" });
    admin.send({ type: "start" });
    const s = await a.wait((m) => m.type === "state" && !m.practice);
    expect(s.position).toEqual({ x: 2, y: 3 });
    expect(ctx.app.match.stage === "intro" || ctx.app.match.stage === "running").toBe(true);
  });
});
