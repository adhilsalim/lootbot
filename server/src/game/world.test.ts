import { describe, expect, it } from "vitest";
import type { MapFile } from "@lootbot/shared";
import { rankStats, World, type WorldEvent } from "./world.js";

/** 10×7 open room. Spawns at (2,3) facing east and (7,3) facing west. */
function room(extra: Partial<MapFile> = {}): MapFile {
  return {
    name: "room",
    width: 10,
    height: 7,
    walls: [],
    gifts: [{ id: "g1", home: [4, 3] }, { id: "g2", home: [4, 1] }],
    ammo: [[2, 5]],
    energy: [[3, 5]],
    spawns: [[2, 3], [7, 3]],
    ...extra,
  };
}

/** Run ticks until the car's action finishes; returns all events. */
function runUntilIdle(w: World, id: string, max = 100) {
  const all: WorldEvent[] = [];
  for (let i = 0; i < max && w.getCar(id)!.action; i++) all.push(...w.step());
  return all;
}
const results = (evs: WorldEvent[], id: string) =>
  evs.filter((e) => e.kind === "actionResult" && e.carId === id).map((e: any) => e.result);
const agentEvents = (evs: WorldEvent[], id: string) =>
  evs.filter((e) => e.kind === "agentEvent" && e.carId === id).map((e: any) => e.name);

describe("World", () => {
  it("spawns cars facing the centre", () => {
    const w = new World(room());
    const a = w.addCar("a", "A")!;
    const b = w.addCar("b", "B")!;
    expect([a.x, a.y, a.heading]).toEqual([2, 3, 90]);
    expect([b.x, b.y, b.heading]).toEqual([7, 3, 270]);
    expect(w.addCar("c", "C")).toBeNull();
  });

  it("turns 45° per tick and reports the final heading", () => {
    const w = new World(room());
    w.addCar("a", "A");
    w.submit("a", "turn", [-135]);
    w.step();
    expect(w.getCar("a")!.heading).toBe(45);
    const evs = runUntilIdle(w, "a");
    expect(results(evs, "a")).toEqual([{ heading: 315 }]);
    expect(w.tick).toBe(3);
  });

  it("moves one step per tick and emits canCollectGift on arrival", () => {
    const w = new World(room());
    w.addCar("a", "A");
    w.submit("a", "move", [2]);
    const evs = runUntilIdle(w, "a");
    expect(w.tick).toBe(2);
    expect(w.getCar("a")).toMatchObject({ x: 4, y: 3 });
    expect(results(evs, "a")).toEqual([{ moved: 2 }]);
    expect(agentEvents(evs, "a")).toContain("canCollectGift");
    expect(w.agentState("a")!.standingOn).toBe("gift");
  });

  it("reverses with negative steps", () => {
    const w = new World(room());
    w.addCar("a", "A");
    w.submit("a", "move", [-1]);
    runUntilIdle(w, "a");
    expect(w.getCar("a")).toMatchObject({ x: 1, y: 3, heading: 90 });
  });

  it("stops at walls and reports blocked", () => {
    const w = new World(room());
    w.addCar("a", "A");
    w.submit("a", "move", [-5]);
    const evs = runUntilIdle(w, "a");
    expect(w.getCar("a")).toMatchObject({ x: 1, y: 3 });
    expect(results(evs, "a")).toEqual([{ moved: 1 }]);
    const blocked = evs.find((e) => e.kind === "agentEvent" && e.name === "blocked") as any;
    expect(blocked.data).toEqual({ by: "wall" });
  });

  it("cars block each other", () => {
    const w = new World(room({ gifts: [{ id: "g1", home: [1, 1] }] }));
    w.addCar("a", "A");
    w.addCar("b", "B");
    w.submit("a", "move", [10]);
    const evs = runUntilIdle(w, "a");
    expect(w.getCar("a")).toMatchObject({ x: 6, y: 3 });
    const blocked = evs.find((e) => e.kind === "agentEvent" && e.name === "blocked") as any;
    expect(blocked.data).toEqual({ by: "agent", team: "B" });
  });

  it("needs collectGift to pick up a gift; driving over is not enough", () => {
    const w = new World(room());
    w.addCar("a", "A");
    w.submit("a", "move", [3]);
    runUntilIdle(w, "a");
    expect(w.giftsOnMap).toBe(2);
    w.submit("a", "move", [-1]);
    runUntilIdle(w, "a");
    w.submit("a", "collectGift");
    const evs = runUntilIdle(w, "a");
    expect(results(evs, "a")).toEqual(["ok"]);
    expect(evs.some((e) => e.kind === "giftCollected")).toBe(true);
    expect(w.agentState("a")).toMatchObject({ myGifts: 1, giftsLeft: 1, standingOn: "none" });
    w.submit("a", "collectGift");
    expect(results(runUntilIdle(w, "a"), "a")).toEqual(["nothing_here"]);
  });

  it("line of sight sees items, walls and agents", () => {
    const w = new World(room());
    w.addCar("a", "A");
    expect(w.agentState("a")!.lineOfSight).toEqual({ type: "gift", distance: 2 });
    w.addCar("b", "B");
    expect(w.agentState("b")!.lineOfSight).toEqual({ type: "gift", distance: 3 });
    const w2 = new World(room({ gifts: [{ id: "g", home: [1, 1] }] }));
    w2.addCar("a", "A");
    w2.addCar("b", "B");
    expect(w2.agentState("a")!.lineOfSight).toEqual({ type: "agent", distance: 5, team: "B" });
    w2.submit("a", "turn", [-90]);
    runUntilIdle(w2, "a");
    expect(w2.agentState("a")!.lineOfSight).toEqual({ type: "wall", distance: 3 });
  });

  it("respects sight range", () => {
    const w = new World(room({ gifts: [{ id: "g", home: [1, 1] }], rules: { sightRange: 3 } }));
    w.addCar("a", "A");
    w.addCar("b", "B");
    expect(w.agentState("a")!.lineOfSight).toEqual({ type: "none", distance: null });
  });

  it("fire hits, removes life, reports the side and starts a cooldown", () => {
    const w = new World(room({ gifts: [{ id: "g", home: [1, 1] }] }));
    w.addCar("a", "A");
    w.addCar("b", "B");
    w.submit("a", "fire");
    const evs = w.step();
    expect(results(evs, "a")).toEqual([{ outcome: "hit", team: "B" }]);
    expect(w.getCar("b")!.life).toBe(75);
    const hit = evs.find((e) => e.kind === "agentEvent" && e.name === "hit") as any;
    expect(hit.data).toEqual({ side: "front", by: "A" });
    expect(w.agentState("a")).toMatchObject({ ammo: 4, fireReady: false, lastShot: "hit" });
    w.submit("a", "fire");
    expect(results(w.step(), "a")).toEqual([{ outcome: "refused", reason: "cooling_down" }]);
    for (let i = 0; i < 8; i++) w.step();
    expect(w.agentState("a")!.fireReady).toBe(true);
  });

  it("reports hits from behind and the side", () => {
    const w = new World(room({ gifts: [{ id: "g", home: [1, 1] }] }));
    w.addCar("a", "A");
    w.addCar("b", "B");
    w.submit("b", "turn", [180]); // b faces east, away from a
    runUntilIdle(w, "b");
    w.submit("a", "fire");
    const hit = w.step().find((e) => e.kind === "agentEvent" && e.name === "hit") as any;
    expect(hit.data.side).toBe("back");
    w.submit("b", "turn", [-90]); // b faces north; a is to its left (west)
    runUntilIdle(w, "b");
    for (let i = 0; i < 10; i++) w.step();
    w.submit("a", "fire");
    const hit2 = w.step().find((e) => e.kind === "agentEvent" && e.name === "hit") as any;
    expect(hit2.data.side).toBe("left");
  });

  it("refuses to fire with no ammo", () => {
    const w = new World(room({ rules: { startAmmo: 0 } }));
    w.addCar("a", "A");
    w.submit("a", "fire");
    expect(results(w.step(), "a")).toEqual([{ outcome: "refused", reason: "no_ammo" }]);
  });

  it("bullets stop at walls", () => {
    const w = new World(room({ walls: [[5, 3]], gifts: [{ id: "g", home: [1, 1] }] }));
    w.addCar("a", "A");
    w.addCar("b", "B");
    w.submit("a", "fire");
    expect(results(w.step(), "a")).toEqual([{ outcome: "miss" }]);
    expect(w.getCar("b")!.life).toBe(100);
  });

  it("death loses the latest gift to its home, respawns with protection", () => {
    const w = new World(room({ rules: { damage: 100 } }));
    w.addCar("a", "A");
    w.addCar("b", "B");
    // b drives to (4,3) and (4,1) picking up both gifts, then returns in front of a.
    w.submit("b", "move", [3]);
    runUntilIdle(w, "b");
    w.submit("b", "collectGift");
    runUntilIdle(w, "b");
    w.submit("b", "turn", [90]); // face north
    runUntilIdle(w, "b");
    w.submit("b", "move", [2]);
    runUntilIdle(w, "b");
    w.submit("b", "collectGift"); // g2 most recent
    runUntilIdle(w, "b");
    w.submit("b", "move", [-2]);
    runUntilIdle(w, "b");
    expect(w.getCar("b")).toMatchObject({ x: 4, y: 3 });
    expect(w.agentState("b")!.myGifts).toBe(2);

    w.submit("a", "fire");
    const evs = w.step();
    expect(w.getCar("b")!.alive).toBe(false);
    expect(evs.find((e) => e.kind === "death")).toMatchObject({ carId: "b", killer: "a" });
    const other = evs.find((e) => e.kind === "agentEvent" && e.name === "otherAgentDied") as any;
    expect(other).toMatchObject({ carId: "a", data: { team: "B", killedBy: "A", lostGift: true, giftHome: [{ x: 4, y: 1 }] } });
    expect(w.agentState("b")!.myGifts).toBe(1);
    expect(w.view().items.find((i) => i.type === "gift")).toMatchObject({ id: "g2", x: 4, y: 1 });

    // Dead car is off the map and cannot act.
    expect(w.submit("b", "move", [1])).toBe(false);
    expect(w.agentState("a")!.lineOfSight.type).not.toBe("agent");

    // Respawn after 3 s at a free spawn (a sits at its spawn, so b gets the other one).
    let respawned: any;
    for (let i = 0; i < 40 && !respawned; i++) {
      respawned = w.step().find((e) => e.kind === "agentEvent" && e.name === "respawned");
    }
    expect(w.tick).toBe(w.getCar("b")!.protectedUntil - 20);
    expect(respawned.data.position).toEqual({ x: 7, y: 3 });
    expect(w.agentState("b")).toMatchObject({ alive: true, protected: true, life: 100, ammo: 5, fireReady: false });

    // Protected: cannot be damaged, cannot fire.
    w.submit("b", "fire");
    expect(results(w.step(), "b")).toEqual([{ outcome: "refused", reason: "protected" }]);
    for (let i = 0; i < 10; i++) w.step();
    w.submit("a", "fire");
    w.step();
    expect(w.getCar("b")!.alive).toBe(true);
    expect(w.getCar("b")!.life).toBe(100);

    const s = Object.fromEntries(w.stats().map((x) => [x.team, x]));
    expect(s.A).toMatchObject({ kills: 1, hitsLanded: 1, shotsFired: 2 });
    expect(s.B).toMatchObject({ deaths: 1, giftsLost: 1, gifts: 1 });
  });

  it("ammo and energy pickups respawn after a delay", () => {
    const w = new World(room({ rules: { startLife: 50, ammoRespawnSec: 1, energyRespawnSec: null } }));
    w.addCar("a", "A");
    w.submit("a", "turn", [90]);
    runUntilIdle(w, "a");
    w.submit("a", "move", [2]); // (2,5): ammo
    runUntilIdle(w, "a");
    w.submit("a", "collectAmmo");
    expect(results(runUntilIdle(w, "a"), "a")).toEqual(["ok"]);
    expect(w.getCar("a")!.ammo).toBe(10);
    expect(w.agentState("a")!.standingOn).toBe("none");
    for (let i = 0; i < 10; i++) w.step();
    expect(w.agentState("a")!.standingOn).toBe("ammo");

    w.submit("a", "turn", [-90]);
    runUntilIdle(w, "a");
    w.submit("a", "move", [1]); // (3,5): energy
    runUntilIdle(w, "a");
    w.submit("a", "collectEnergy");
    runUntilIdle(w, "a");
    expect(w.getCar("a")!.life).toBe(80);
    for (let i = 0; i < 500; i++) w.step();
    expect(w.agentState("a")!.standingOn).toBe("none"); // "never" respawns
  });

  it("stop cancels a long move", () => {
    const w = new World(room());
    w.addCar("a", "A");
    w.submit("a", "move", [5]);
    w.step();
    const r = w.stop("a");
    expect(r).toMatchObject({ result: { moved: 1 }, stopped: true });
    expect(w.agentState("a")!.busy).toBe(false);
  });

  it("idle waits the given ticks", () => {
    const w = new World(room());
    w.addCar("a", "A");
    w.submit("a", "idle", [3]);
    expect(results(runUntilIdle(w, "a"), "a")).toEqual(["done"]);
    expect(w.tick).toBe(3);
  });

  it("removing a car sends its gifts home", () => {
    const w = new World(room());
    w.addCar("a", "A");
    w.submit("a", "move", [2]);
    runUntilIdle(w, "a");
    w.submit("a", "collectGift");
    runUntilIdle(w, "a");
    expect(w.giftsOnMap).toBe(1);
    w.removeCar("a");
    expect(w.giftsOnMap).toBe(2);
  });

  it("hides items and scoreboard when the map says so", () => {
    const w = new World(room({ rules: { revealItems: false, showScoreboard: false } }));
    w.addCar("a", "A");
    expect(w.agentState("a")).toMatchObject({ itemLocations: "hidden", scoreboard: "hidden" });
    const w2 = new World(room());
    w2.addCar("a", "A");
    expect(w2.agentState("a")!.itemLocations).toHaveLength(4);
    expect(w2.agentState("a")!.scoreboard).toEqual({ A: 0 });
  });

  it("snapshot and restore round-trip", () => {
    const w = new World(room());
    w.addCar("a", "A");
    w.submit("a", "move", [2]);
    w.step();
    const snap = JSON.parse(JSON.stringify(w.snapshot()));
    w.step();
    w.step();
    w.restore(snap);
    expect(w.tick).toBe(1);
    expect(w.getCar("a")).toMatchObject({ x: 3, y: 3 });
  });

  it("time left counts down with ticks", () => {
    const w = new World(room({ rules: { matchSeconds: 2 } }));
    expect(w.timeLeft).toBe(2);
    for (let i = 0; i < 5; i++) w.step();
    expect(w.timeLeft).toBe(1.5);
  });
});

describe("rankStats", () => {
  const base = { deaths: 0, hitsLanded: 0, hitsTaken: 0, shotsFired: 0, kills: 0, giftsLost: 0, pickups: 0, distance: 0, lifeLeft: 100 };
  it("ranks by gifts, then fewer deaths, then hits, then life", () => {
    const r = rankStats([
      { ...base, team: "A", gifts: 2, deaths: 1 },
      { ...base, team: "B", gifts: 3 },
      { ...base, team: "C", gifts: 2, deaths: 0 },
      { ...base, team: "D", gifts: 2, deaths: 1, hitsLanded: 3, shotsFired: 4 },
    ]);
    expect(r.map((x) => x.team)).toEqual(["B", "C", "D", "A"]);
    expect(r[2].accuracy).toBe(0.75);
  });
});
