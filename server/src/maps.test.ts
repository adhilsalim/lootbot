import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { blankMap } from "@lootbot/shared";
import { sleep, startTestApp, testMap, TestClient } from "./testUtil.js";

describe("map builder API", () => {
  let ctx: Awaited<ReturnType<typeof startTestApp>>;
  let base: string;
  const api = async (method: string, path: string, body?: unknown, key = "secret") => {
    const res = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json", "x-admin-key": key },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  beforeEach(async () => {
    ctx = await startTestApp();
    base = `http://localhost:${ctx.app.port}`;
  });
  afterEach(() => ctx.app.close());

  it("requires the admin key", async () => {
    expect((await api("GET", "/api/admin/maps", undefined, "bad")).status).toBe(401);
  });

  it("lists, saves, duplicates, renames and deletes maps", async () => {
    expect((await api("GET", "/api/admin/maps")).body).toEqual([{ file: "test-room.json", name: "Test Room", width: 10, height: 7 }]);

    const map = { ...blankMap("My Level", 12, 8), gifts: [{ id: "g1", home: [5, 4] }] };
    const saved = await api("POST", "/api/admin/maps", { map });
    expect(saved.body.file).toBe("my-level.json");
    expect((await api("GET", "/api/admin/maps/my-level.json")).body.name).toBe("My Level");

    const dup = await api("POST", "/api/admin/maps/my-level.json/duplicate");
    expect(dup.body.file).toBe("my-level-copy.json");
    const dup2 = await api("POST", "/api/admin/maps/my-level.json/duplicate");
    expect(dup2.body.file).toBe("my-level-copy-2.json");

    const ren = await api("POST", "/api/admin/maps/my-level-copy.json/rename", { name: "Hard Mode" });
    expect(ren.body.file).toBe("hard-mode.json");
    expect((await api("GET", "/api/admin/maps/hard-mode.json")).body.name).toBe("Hard Mode");
    expect((await api("POST", "/api/admin/maps/hard-mode.json/rename", { name: "Test Room" })).status).toBe(400);

    await api("DELETE", "/api/admin/maps/hard-mode.json");
    const files = (await api("GET", "/api/admin/maps")).body.map((m: any) => m.file);
    expect(files).toEqual(["my-level-copy-2.json", "my-level.json", "test-room.json"]);
  });

  it("refuses to save an invalid map and explains why", async () => {
    const r = await api("POST", "/api/admin/maps", { map: blankMap("Empty", 10, 8) });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/gift/);
  });

  it("validates without saving", async () => {
    const r = await api("POST", "/api/admin/validate", { map: testMap });
    expect(r.body).toMatchObject({ ok: true });
  });

  it("rejects path tricks in file names", async () => {
    const r = await api("GET", "/api/admin/maps/..%2F..%2Fpackage.json");
    expect(r.status).toBe(400);
  });

  it("test run plays the map with built-in bots", async () => {
    const admin = new TestClient(`ws://localhost:${ctx.app.port}/ws/admin?key=secret`);
    await admin.open();
    admin.send({ type: "testRun", file: "test-room.json" });
    await admin.wait((m) => m.type === "state" && m.testRun && m.stage === "running", 3000);
    await sleep(300);
    const world = ctx.app.match.world!;
    expect(world.allCars().map((c) => c.team)).toEqual(["Bot Falcon", "Bot Eagle", "Bot Hawk", "Bot Owl"]);
    expect(world.tick).toBeGreaterThan(2);
    expect(world.stats().reduce((a, s) => a + s.distance, 0)).toBeGreaterThan(0);
    admin.send({ type: "abort" });
    await admin.wait((m) => m.type === "state" && !m.testRun && m.stage === "lobby");
    admin.close();
  });
});
