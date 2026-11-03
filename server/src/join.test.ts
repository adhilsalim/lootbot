import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sleep, startTestApp, TestClient } from "./testUtil.js";

describe("join flow", () => {
  let ctx: Awaited<ReturnType<typeof startTestApp>>;
  let admin: TestClient;
  const clients: TestClient[] = [];
  const client = async (path = "/agent") => {
    const c = new TestClient(ctx.url + path);
    clients.push(c);
    await c.open();
    return c;
  };
  const adminCmd = (cmd: unknown) => admin.send(cmd);
  const adminState = (pred: (s: any) => boolean) => admin.wait((m) => m.type === "state" && pred(m), 3000, 0);
  const nextAdminState = (pred: (s: any) => boolean) => admin.next((m) => m.type === "state" && pred(m));

  /** Join and get accepted by the host; returns the client and its token. */
  async function joinAccepted(team: string) {
    const c = await client();
    c.send({ type: "join", joinCode: "ABCD", teamName: team });
    await c.wait((m) => m.type === "joinResult" && m.status === "pending");
    const s = await adminState((s) => s.agents.some((a: any) => a.team === team && a.status === "pending"));
    const id = s.agents.find((a: any) => a.team === team).id;
    adminCmd({ type: "accept", id });
    const r = await c.wait((m) => m.type === "joinResult" && m.accepted);
    return { c, token: r.token as string, id };
  }

  beforeEach(async () => {
    ctx = await startTestApp();
    admin = new TestClient(`${ctx.url}/ws/admin?key=secret`);
    clients.push(admin);
    await admin.open();
    await admin.wait((m) => m.type === "state");
  });
  afterEach(async () => {
    clients.splice(0).forEach((c) => c.close());
    await ctx.app.close();
  });

  it("rejects an admin connection without the key", async () => {
    const bad = await client("/ws/admin?key=nope");
    await bad.waitClosed();
  });

  it("rejects a wrong join code immediately", async () => {
    const c = await client();
    c.send({ type: "join", joinCode: "WRONG", teamName: "Falcon" });
    const r = await c.wait((m) => m.type === "joinResult");
    expect(r).toMatchObject({ accepted: false, reason: "Wrong join code." });
    await c.waitClosed();
  });

  it("join code is case-insensitive and the root path works", async () => {
    const c = await client("/");
    c.send({ type: "join", joinCode: "abcd", teamName: "Falcon" });
    expect(await c.wait((m) => m.type === "joinResult")).toMatchObject({ status: "pending" });
  });

  it("accepts with a token and rejects duplicate team names", async () => {
    const { token } = await joinAccepted("Falcon");
    expect(token).toMatch(/^t_/);
    const dup = await client();
    dup.send({ type: "join", joinCode: "ABCD", teamName: "falcon" });
    expect(await dup.wait((m) => m.type === "joinResult")).toMatchObject({ accepted: false, reason: expect.stringMatching(/taken/) });
  });

  it("declines with a reason and closes", async () => {
    const c = await client();
    c.send({ type: "join", joinCode: "ABCD", teamName: "Eagle" });
    const s = await adminState((s) => s.agents.length === 1);
    adminCmd({ type: "decline", id: s.agents[0].id, reason: "Too late" });
    expect(await c.next((m) => m.type === "joinResult")).toMatchObject({ accepted: false, reason: "Too late" });
    await c.waitClosed();
    await nextAdminState((s) => s.agents.length === 0);
  });

  it("drives a car with the token; actions without it are rejected", async () => {
    const { c, token, id } = await joinAccepted("Falcon");
    adminCmd({ type: "selectMap", file: "test-room.json" });
    adminCmd({ type: "start", override: true });
    const st = await c.wait((m) => m.type === "state", 3000);
    expect(st).toMatchObject({ position: { x: 2, y: 3 }, heading: 90 });

    c.send({ type: "action", token: "t_wrong", tick: st.tick, name: "move", args: [1] });
    expect(await c.wait((m) => m.type === "error")).toMatchObject({ reason: expect.stringMatching(/token/) });

    // Reply to the next state with a move.
    const s2 = await c.next((m) => m.type === "state");
    c.send({ type: "action", token, tick: s2.tick, name: "move", args: [1] });
    expect(await c.wait((m) => m.type === "actionResult")).toMatchObject({ name: "move", result: { moved: 1 } });
    expect(ctx.app.match.world!.getCar(id)).toMatchObject({ x: 3, y: 3 });
  });

  it("a dropped car idles and the same token takes it back", async () => {
    const { c, token, id } = await joinAccepted("Falcon");
    adminCmd({ type: "selectMap", file: "test-room.json" });
    adminCmd({ type: "start", override: true });
    const s = await c.wait((m) => m.type === "state");
    c.send({ type: "action", token, tick: s.tick, name: "move", args: [3] });
    await c.next((m) => m.type === "state");
    c.close();
    await sleep(100);
    const car = ctx.app.match.world!.getCar(id)!;
    expect(car.connected).toBe(false);
    const x = car.x;
    await sleep(100);
    expect(car.x).toBe(x);

    const imposter = await client();
    imposter.send({ type: "join", joinCode: "ABCD", teamName: "X", token: "t_guess" });
    expect(await imposter.wait((m) => m.type === "joinResult")).toMatchObject({ accepted: false, reason: "Unknown token." });

    const back = await client();
    back.send({ type: "join", joinCode: "ABCD", teamName: "Falcon", token });
    expect(await back.wait((m) => m.type === "joinResult")).toMatchObject({ accepted: true, status: "reconnected" });
    const s2 = await back.wait((m) => m.type === "state");
    expect(car.connected).toBe(true);
    back.send({ type: "action", token, tick: s2.tick, name: "turn", args: [90] });
    expect(await back.wait((m) => m.type === "actionResult")).toMatchObject({ result: { heading: 180 } });
  });

  it("kicking removes the car and closes the connection", async () => {
    const { c, id } = await joinAccepted("Falcon");
    await joinAccepted("Eagle");
    adminCmd({ type: "selectMap", file: "test-room.json" });
    adminCmd({ type: "start", override: true });
    await c.wait((m) => m.type === "state");
    adminCmd({ type: "kick", id });
    expect(await c.wait((m) => m.type === "event" && m.name === "kicked")).toBeTruthy();
    await c.waitClosed();
    expect(ctx.app.match.world!.allCars().map((x) => x.team)).toEqual(["Eagle"]);
  });

  it("refuses to start without a passed connection test unless overridden", async () => {
    await joinAccepted("Falcon");
    adminCmd({ type: "selectMap", file: "test-room.json" });
    adminCmd({ type: "start" });
    expect(await admin.wait((m) => m.type === "error")).toMatchObject({ message: expect.stringMatching(/connection test/) });
  });
});
