import { describe, expect, it } from "vitest";
import { DEFAULT_RULES, resolveRules, secToTicks } from "./rules.js";
import { blankMap, validateMap, wallSet, type MapFile } from "./map.js";
import { parseAgentMessage } from "./protocol.js";

describe("rules", () => {
  it("fills missing rules with defaults", () => {
    const r = resolveRules({ damage: 50 });
    expect(r.damage).toBe(50);
    expect(r.startLife).toBe(DEFAULT_RULES.startLife);
  });
  it("converts seconds to ticks", () => {
    expect(secToTicks(3, 10)).toBe(30);
    expect(secToTicks(0.01, 10)).toBe(1);
    expect(secToTicks(0, 10)).toBe(0);
  });
});

describe("validateMap", () => {
  const base = (): MapFile => ({
    ...blankMap("Test", 10, 8),
    gifts: [{ id: "g1", home: [5, 4] }],
  });

  it("accepts a simple open map", () => {
    expect(validateMap(base())).toMatchObject({ ok: true, errors: [] });
  });
  it("adds the border automatically", () => {
    const w = wallSet(base());
    expect(w.has("0,0")).toBe(true);
    expect(w.has("9,7")).toBe(true);
    expect(w.has("5,4")).toBe(false);
  });
  it("requires gifts and enough spawns", () => {
    const m = base();
    m.gifts = [];
    m.spawns = [[1, 1]];
    const r = validateMap(m, 2);
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/gift/);
    expect(r.errors.join()).toMatch(/spawn/);
  });
  it("detects unreachable gifts", () => {
    const m = base();
    // Box in the gift at (5,4).
    m.walls = [[4, 3], [5, 3], [6, 3], [4, 4], [6, 4], [4, 5], [5, 5], [6, 5]];
    const r = validateMap(m);
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toMatch(/unreachable/);
  });
  it("rejects items on walls or overlapping", () => {
    const m = base();
    m.walls = [[5, 4]];
    m.ammo = [[1, 1]];
    const r = validateMap(m);
    expect(r.errors.join()).toMatch(/on a wall/);
    expect(r.errors.join()).toMatch(/overlaps/);
  });
});

describe("parseAgentMessage", () => {
  it("parses a valid action", () => {
    const m = parseAgentMessage('{"type":"action","token":"t","tick":3,"name":"move","args":[2]}');
    expect(m).toMatchObject({ type: "action", name: "move", args: [2] });
  });
  it("defaults missing args", () => {
    expect(parseAgentMessage('{"type":"action","token":"t","tick":3,"name":"fire"}')).toMatchObject({ args: [] });
  });
  it("rejects bad input", () => {
    expect(parseAgentMessage("not json")).toBeNull();
    expect(parseAgentMessage('{"type":"action","token":"t","tick":3,"name":"teleport"}')).toBeNull();
    expect(parseAgentMessage('{"type":"action","token":"t","tick":3,"name":"move","args":["x"]}')).toBeNull();
    expect(parseAgentMessage('{"type":"join","teamName":"A"}')).toBeNull();
  });
});
