import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MapFile, ServerToAgent, ServerToStage } from "@lootbot/shared";
import { Match } from "./match.js";

const map: MapFile = {
  name: "room",
  width: 10,
  height: 7,
  walls: [],
  gifts: [{ id: "g1", home: [4, 3] }],
  ammo: [],
  energy: [],
  spawns: [[2, 3], [7, 3]],
  rules: { matchSeconds: 2, tickRate: 10 },
};

function setup() {
  const m = new Match({ perTeamMs: 100, countdownStepMs: 10, finishedHoldMs: 50 });
  const agent: Record<string, ServerToAgent[]> = { a: [], b: [] };
  const stage: ServerToStage[] = [];
  m.on("agent", (id, msg) => agent[id].push(msg));
  m.on("stage", (msg) => stage.push(msg));
  m.setMap(map);
  return { m, agent, stage };
}
const teams = [{ carId: "a", team: "A" }, { carId: "b", team: "B" }];
const last = <T>(arr: T[], pred: (x: T) => boolean) => [...arr].reverse().find(pred);

describe("Match", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs lobby → intro → countdown → running → finished → stats", () => {
    const { m, agent, stage } = setup();
    m.toReady();
    m.start(teams);
    expect(m.stage).toBe("intro");
    vi.advanceTimersByTime(200);
    expect(stage.filter((s) => s.type === "countdown").map((s: any) => s.value)).toEqual([3]);
    vi.advanceTimersByTime(30);
    expect(m.stage).toBe("running");
    expect(agent.a.some((x) => x.type === "event" && x.name === "gameStarted")).toBe(true);
    expect(agent.a.some((x) => x.type === "state" && x.tick === 0)).toBe(true);

    vi.advanceTimersByTime(2000); // 20 ticks = matchSeconds
    expect(m.stage).toBe("finished");
    expect(m.world!.tick).toBe(20);
    expect(agent.b.some((x) => x.type === "event" && x.name === "gameEnded")).toBe(true);
    vi.advanceTimersByTime(60);
    expect(m.stage).toBe("stats");
    expect(last(stage, (s) => s.type === "stats")).toMatchObject({ type: "stats", stats: [{ rank: 1 }, { rank: 2 }] });
  });

  it("applies actions stamped with the current tick and ignores late ones", () => {
    const { m, agent } = setup();
    m.start(teams);
    m.skipIntro();
    vi.advanceTimersByTime(30);
    expect(m.stage).toBe("running");
    m.receiveAction({ carId: "a", tick: 0, name: "move", args: [1] });
    m.receiveAction({ carId: "b", tick: 5, name: "move", args: [1] }); // wrong tick
    m.tick();
    expect(m.world!.getCar("a")!.x).toBe(3);
    expect(m.world!.getCar("b")!.x).toBe(7);
    expect(last(agent.a, (x) => x.type === "actionResult")).toMatchObject({ name: "move", result: { moved: 1 }, tick: 0 });
    m.receiveAction({ carId: "b", tick: 0, name: "move", args: [1] }); // late (now tick 1)
    m.tick();
    expect(m.world!.getCar("b")!.x).toBe(7);
  });

  it("pause freezes the timer and ticks; resume continues", () => {
    const { m, agent } = setup();
    m.start(teams);
    m.skipIntro();
    vi.advanceTimersByTime(30 + 500);
    const t = m.world!.tick;
    expect(t).toBeGreaterThanOrEqual(4);
    m.pause();
    expect(agent.a.some((x) => x.type === "event" && x.name === "gamePaused")).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(m.world!.tick).toBe(t);
    expect(m.stage).toBe("paused");
    m.resume();
    vi.advanceTimersByTime(300);
    expect(m.world!.tick).toBe(t + 3);
  });

  it("finishes early when no gifts remain on the map", () => {
    const { m } = setup();
    m.start(teams);
    m.skipIntro();
    vi.advanceTimersByTime(30);
    const ends: string[] = [];
    m.on("end", (_w, _s, reason) => ends.push(reason));
    m.receiveAction({ carId: "a", tick: 0, name: "move", args: [2] });
    m.tick();
    m.tick();
    m.receiveAction({ carId: "a", tick: 2, name: "collectGift", args: [] });
    m.tick();
    expect(m.stage).toBe("finished");
    expect(ends).toEqual(["gifts"]);
    expect(m.lastStats![0]).toMatchObject({ team: "A", gifts: 1, rank: 1 });
  });

  it("abort returns to the lobby and stops ticking", () => {
    const { m, agent } = setup();
    m.start(teams);
    m.skipIntro();
    vi.advanceTimersByTime(130);
    m.abort();
    expect(m.stage).toBe("lobby");
    expect(m.world).toBeNull();
    expect(last(agent.a, (x) => x.type === "event")).toMatchObject({ name: "gameEnded", reason: "aborted" });
    vi.advanceTimersByTime(1000);
    expect(m.stage).toBe("lobby");
  });

  it("rejects actions outside running and refuses invalid transitions", () => {
    const { m } = setup();
    expect(() => m.pause()).toThrow();
    m.start(teams);
    m.receiveAction({ carId: "a", tick: 0, name: "move", args: [1] });
    expect(() => m.setMap(map)).toThrow();
    m.skipIntro();
    vi.advanceTimersByTime(30);
    m.tick();
    expect(m.world!.getCar("a")!.x).toBe(2);
  });

  it("stop cancels immediately and a disconnected car idles", () => {
    const { m, agent } = setup();
    m.start(teams);
    m.skipIntro();
    vi.advanceTimersByTime(30);
    m.receiveAction({ carId: "a", tick: 0, name: "move", args: [3] });
    m.tick();
    m.receiveStop("a");
    expect(last(agent.a, (x) => x.type === "actionResult")).toMatchObject({ stopped: true, result: { moved: 1 } });
    m.receiveAction({ carId: "b", tick: 1, name: "move", args: [3] });
    m.tick();
    m.setConnected("b", false);
    m.tick();
    expect(m.world!.getCar("b")!.x).toBe(6);
  });

  it("removing a car mid-match sends its gifts home", () => {
    const { m } = setup();
    m.start(teams);
    m.skipIntro();
    vi.advanceTimersByTime(30);
    m.receiveAction({ carId: "a", tick: 0, name: "move", args: [2] });
    m.tick();
    m.tick();
    m.removeCar("b");
    expect(m.hasCar("b")).toBe(false);
    expect(m.world!.allCars()).toHaveLength(1);
  });
});
