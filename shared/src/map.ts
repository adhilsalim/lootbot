import type { Rules } from "./rules.js";

export type Cell = [x: number, y: number];

export interface GiftDef {
  id: string;
  /** Where the gift starts, and where it returns when a dying car loses it. */
  home: Cell;
}

/** A map as saved in `maps/<file>.json`. */
export interface MapFile {
  name: string;
  width: number;
  height: number;
  walls: Cell[];
  gifts: GiftDef[];
  ammo: Cell[];
  energy: Cell[];
  spawns: Cell[];
  rules?: Partial<Rules>;
}

export type CellKind = "floor" | "wall" | "gift" | "ammo" | "energy" | "spawn";

export const cellKey = (x: number, y: number) => `${x},${y}`;

/** True for cells on the outer edge; the border is always wall. */
export function isBorder(map: Pick<MapFile, "width" | "height">, x: number, y: number) {
  return x === 0 || y === 0 || x === map.width - 1 || y === map.height - 1;
}

/** Wall set including the automatic border. */
export function wallSet(map: MapFile): Set<string> {
  const set = new Set<string>();
  for (const [x, y] of map.walls) set.add(cellKey(x, y));
  for (let x = 0; x < map.width; x++) {
    set.add(cellKey(x, 0));
    set.add(cellKey(x, map.height - 1));
  }
  for (let y = 0; y < map.height; y++) {
    set.add(cellKey(0, y));
    set.add(cellKey(map.width - 1, y));
  }
  return set;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Check a map is playable: enough spawn points, at least one gift, nothing placed
 * on a wall or out of bounds, and every gift and spawn reachable from every spawn.
 */
export function validateMap(map: MapFile, expectedTeams = 2): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!map.name?.trim()) errors.push("Map needs a name.");
  if (!Number.isInteger(map.width) || !Number.isInteger(map.height) || map.width < 5 || map.height < 5) {
    errors.push("Grid must be at least 5 × 5.");
    return { ok: false, errors, warnings };
  }
  if (map.width > 200 || map.height > 200) errors.push("Grid must be at most 200 × 200.");

  const walls = wallSet(map);
  const occupied = new Map<string, string>();
  const place = (what: string, [x, y]: Cell) => {
    const k = cellKey(x, y);
    if (x < 0 || y < 0 || x >= map.width || y >= map.height) {
      errors.push(`${what} at (${x}, ${y}) is outside the grid.`);
      return;
    }
    if (walls.has(k)) errors.push(`${what} at (${x}, ${y}) is on a wall.`);
    const prev = occupied.get(k);
    if (prev) errors.push(`${what} at (${x}, ${y}) overlaps ${prev}.`);
    occupied.set(k, what);
  };

  const ids = new Set<string>();
  for (const g of map.gifts) {
    if (ids.has(g.id)) errors.push(`Duplicate gift id "${g.id}".`);
    ids.add(g.id);
    place(`Gift ${g.id}`, g.home);
  }
  map.ammo.forEach((c) => place("Ammo", c));
  map.energy.forEach((c) => place("Energy drink", c));
  map.spawns.forEach((c) => place("Spawn point", c));

  if (map.gifts.length === 0) errors.push("Place at least one gift.");
  if (map.spawns.length < expectedTeams) {
    errors.push(`Need at least ${expectedTeams} spawn points (have ${map.spawns.length}).`);
  }
  if (errors.length) return { ok: false, errors, warnings };

  // Everything must be in one connected floor region with the first spawn.
  const reach = floodFill(map, walls, map.spawns[0]);
  for (const s of map.spawns) {
    if (!reach.has(cellKey(...s))) errors.push(`Spawn point (${s[0]}, ${s[1]}) cannot reach the other spawns.`);
  }
  for (const g of map.gifts) {
    if (!reach.has(cellKey(...g.home))) errors.push(`Gift ${g.id} at (${g.home[0]}, ${g.home[1]}) is unreachable.`);
  }
  for (const c of [...map.ammo, ...map.energy]) {
    if (!reach.has(cellKey(...c))) warnings.push(`Item at (${c[0]}, ${c[1]}) is unreachable.`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

function floodFill(map: MapFile, walls: Set<string>, start: Cell): Set<string> {
  const seen = new Set<string>([cellKey(...start)]);
  const queue: Cell[] = [start];
  while (queue.length) {
    const [x, y] = queue.shift()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      const k = cellKey(nx, ny);
      if (nx < 0 || ny < 0 || nx >= map.width || ny >= map.height) continue;
      if (walls.has(k) || seen.has(k)) continue;
      seen.add(k);
      queue.push([nx, ny]);
    }
  }
  return seen;
}

/** A blank map of the given size with four corner spawns. */
export function blankMap(name: string, width = 30, height = 20): MapFile {
  return {
    name,
    width,
    height,
    walls: [],
    gifts: [],
    ammo: [],
    energy: [],
    spawns: [[1, 1], [width - 2, 1], [1, height - 2], [width - 2, height - 2]],
    rules: {},
  };
}
