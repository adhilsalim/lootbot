import {
  cellKey,
  resolveRules,
  secToTicks,
  wallSet,
  type ActionName,
  type ActionResultValue,
  type AgentEventName,
  type AgentState,
  type CarView,
  type FireResult,
  type ItemLocation,
  type ItemType,
  type LineOfSight,
  type MapFile,
  type Rules,
  type ShotView,
  type Side,
  type TeamStats,
  type WorldView,
} from "@lootbot/shared";

/** Something that happened during a tick, for the match layer to route to agents, stage and audio. */
export type WorldEvent =
  | { kind: "agentEvent"; carId: string; name: AgentEventName; data?: Record<string, unknown> }
  | { kind: "actionResult"; carId: string; name: ActionName; result: ActionResultValue; stopped?: boolean }
  /** Audio-relevant moments. `x` is the car's position for left/right panning. */
  | { kind: "shotHit"; shooter: string; target: string; killed: boolean; shooterX: number; targetX: number }
  | { kind: "giftCollected"; carId: string; x: number }
  | { kind: "death"; carId: string; killer: string | null; x: number };

interface RunningAction {
  name: ActionName;
  /** Ticks or steps/degrees still to do. */
  remaining: number;
  /** Accumulated progress (degrees turned or cells moved). */
  done: number;
}

export interface Car {
  id: string;
  team: string;
  x: number;
  y: number;
  heading: number;
  life: number;
  ammo: number;
  alive: boolean;
  /** Tick at which the dead car respawns. */
  respawnAt: number;
  /** Protected (no damage, no firing) until this tick. */
  protectedUntil: number;
  /** Can fire again at this tick. */
  cooldownUntil: number;
  lastShot: "hit" | "miss" | "none";
  /** Gift ids held, oldest first. */
  gifts: string[];
  action: RunningAction | null;
  connected: boolean;
  stats: Omit<TeamStats, "team" | "gifts" | "lifeLeft">;
}

interface Pickup {
  type: "ammo" | "energy";
  x: number;
  y: number;
  /** Tick from which it can be collected again; Infinity = gone for good. */
  availableAt: number;
}

interface Gift {
  id: string;
  home: [number, number];
  /** Car holding it, or null if it sits on its home cell. */
  heldBy: string | null;
}

const norm360 = (deg: number) => ((deg % 360) + 360) % 360;
const norm180 = (deg: number) => {
  const d = norm360(deg);
  return d > 180 ? d - 360 : d;
};
const round2 = (n: number) => Math.round(n * 100) / 100;
const dirOf = (heading: number) => {
  const r = (heading * Math.PI) / 180;
  // Heading 0 = north (−y), 90 = east (+x).
  const snap = (n: number) => Math.round(n * 1e9) / 1e9;
  return { dx: snap(Math.sin(r)), dy: snap(-Math.cos(r)) };
};
/** The cell a continuous position belongs to. Cell (x, y) has its centre at (x, y). */
const cellOf = (x: number, y: number): [number, number] => [Math.round(x), Math.round(y)];

/**
 * The whole game state and rules. Pure and deterministic: no timers, no I/O.
 * The match layer calls `submit` for each agent's action, then `step()` once per tick.
 */
export class World {
  readonly rules: Rules;
  readonly map: MapFile;
  tick = 0;
  /** Ticks the match lasts; `timeLeft` is derived from this. */
  readonly matchTicks: number;

  private walls: Set<string>;
  private cars = new Map<string, Car>();
  private order: string[] = [];
  private gifts: Gift[];
  private pickups: Pickup[];
  private shots: ShotView[] = [];
  private nextSpawn = 0;

  constructor(map: MapFile, rules?: Partial<Rules>) {
    this.map = map;
    this.rules = resolveRules({ ...(map.rules ?? {}), ...(rules ?? {}) });
    this.walls = wallSet(map);
    this.gifts = map.gifts.map((g) => ({ id: g.id, home: [g.home[0], g.home[1]], heldBy: null }));
    this.pickups = [
      ...map.ammo.map(([x, y]) => ({ type: "ammo" as const, x, y, availableAt: 0 })),
      ...map.energy.map(([x, y]) => ({ type: "energy" as const, x, y, availableAt: 0 })),
    ];
    this.matchTicks = Math.round(this.rules.matchSeconds * this.rules.tickRate);
  }

  // ---------- setup ----------

  /** Place a new car at a free spawn point. Returns null if every spawn is taken. */
  addCar(id: string, team: string): Car | null {
    if (this.cars.has(id)) return this.cars.get(id)!;
    const spawn = this.freeSpawn();
    if (!spawn) return null;
    const car: Car = {
      id,
      team,
      x: spawn[0],
      y: spawn[1],
      heading: this.headingTowardCentre(spawn),
      life: this.rules.startLife,
      ammo: this.rules.startAmmo,
      alive: true,
      respawnAt: 0,
      protectedUntil: 0,
      cooldownUntil: 0,
      lastShot: "none",
      gifts: [],
      action: null,
      connected: true,
      stats: { deaths: 0, hitsLanded: 0, hitsTaken: 0, shotsFired: 0, kills: 0, giftsLost: 0, pickups: 0, distance: 0 },
    };
    this.cars.set(id, car);
    this.order.push(id);
    return car;
  }

  /** Remove a car (kicked). Its gifts go back to their home cells. */
  removeCar(id: string) {
    const car = this.cars.get(id);
    if (!car) return;
    for (const gid of car.gifts) this.giftById(gid)!.heldBy = null;
    this.cars.delete(id);
    this.order = this.order.filter((c) => c !== id);
  }

  getCar(id: string) {
    return this.cars.get(id);
  }

  allCars() {
    return this.order.map((id) => this.cars.get(id)!);
  }

  setConnected(id: string, connected: boolean) {
    const car = this.cars.get(id);
    if (!car) return;
    car.connected = connected;
    // A disconnected car stands still.
    if (!connected) car.action = null;
  }

  // ---------- input ----------

  /** Start an action for an idle, living car. Returns false if the car cannot act right now. */
  submit(id: string, name: ActionName, args: number[] = []): boolean {
    const car = this.cars.get(id);
    if (!car || !car.alive || car.action) return false;
    const a0 = Number.isFinite(args[0]) ? args[0] : 0;
    switch (name) {
      case "turn":
        car.action = { name, remaining: a0, done: 0 };
        break;
      case "move":
        car.action = { name, remaining: a0, done: 0 };
        break;
      case "idle":
        car.action = { name, remaining: Math.max(1, Math.floor(a0) || 1), done: 0 };
        break;
      default:
        car.action = { name, remaining: 1, done: 0 };
    }
    return true;
  }

  /** Cancel a running action early. The result reports progress so far. */
  stop(id: string): WorldEvent | null {
    const car = this.cars.get(id);
    if (!car?.action) return null;
    const a = car.action;
    car.action = null;
    return { kind: "actionResult", carId: id, name: a.name, result: this.partialResult(car, a), stopped: true };
  }

  // ---------- simulation ----------

  /** Advance one tick. Returns everything that happened. */
  step(): WorldEvent[] {
    const events: WorldEvent[] = [];
    this.shots = [];
    const t = this.tick;

    // Respawn dead cars whose delay is over.
    for (const car of this.allCars()) {
      if (!car.alive && t >= car.respawnAt) this.respawn(car, events);
    }

    // Rotate processing order each tick so no car always moves first.
    const ids = this.order.length ? this.order.map((_, i) => this.order[(i + t) % this.order.length]) : [];
    for (const id of ids) {
      const car = this.cars.get(id);
      if (!car?.alive || !car.action) continue;
      this.runAction(car, events);
    }

    this.tick++;
    return events;
  }

  private runAction(car: Car, events: WorldEvent[]) {
    const a = car.action!;
    const finish = (result: ActionResultValue) => {
      car.action = null;
      events.push({ kind: "actionResult", carId: car.id, name: a.name, result });
    };

    switch (a.name) {
      case "turn": {
        const stepDeg = Math.sign(a.remaining) * Math.min(Math.abs(a.remaining), this.rules.turnPerTick);
        car.heading = round2(norm360(car.heading + stepDeg));
        a.remaining -= stepDeg;
        a.done += stepDeg;
        if (Math.abs(a.remaining) < 1e-9) finish({ heading: car.heading });
        return;
      }
      case "move": {
        if (a.remaining === 0) return finish({ moved: 0 });
        const dist = Math.sign(a.remaining) * Math.min(Math.abs(a.remaining), this.rules.movePerTick);
        const { moved, blockedBy } = this.tryMove(car, dist, events);
        a.done += moved;
        a.remaining -= dist;
        if (blockedBy) {
          events.push({ kind: "agentEvent", carId: car.id, name: "blocked", data: blockedBy });
          return finish({ moved: round2(Math.abs(a.done)) });
        }
        if (Math.abs(a.remaining) < 1e-9) finish({ moved: round2(Math.abs(a.done)) });
        return;
      }
      case "fire":
        return finish(this.fire(car, events));
      case "collectGift": {
        const gift = this.giftAt(car.x, car.y);
        if (!gift) return finish("nothing_here");
        gift.heldBy = car.id;
        car.gifts.push(gift.id);
        events.push({ kind: "giftCollected", carId: car.id, x: car.x });
        return finish("ok");
      }
      case "collectAmmo":
      case "collectEnergy": {
        const type = a.name === "collectAmmo" ? "ammo" : "energy";
        const p = this.pickupAt(car.x, car.y, type);
        if (!p) return finish("nothing_here");
        const delay = type === "ammo" ? this.rules.ammoRespawnSec : this.rules.energyRespawnSec;
        p.availableAt = delay === null ? Infinity : this.tick + 1 + secToTicks(delay, this.rules.tickRate);
        if (type === "ammo") car.ammo = Math.min(this.rules.maxAmmo, car.ammo + this.rules.ammoPerPickup);
        else car.life = Math.min(this.rules.maxLife, car.life + this.rules.energyPerDrink);
        car.stats.pickups++;
        return finish("ok");
      }
      case "idle":
        a.remaining--;
        a.done++;
        if (a.remaining <= 0) finish("done");
        return;
    }
  }

  /** Move along the heading by `dist` cells (negative = reverse), stopping at walls and cars. */
  private tryMove(car: Car, dist: number, events: WorldEvent[]) {
    const { dx, dy } = dirOf(car.heading);
    const start = { x: car.x, y: car.y };
    const startCell = cellOf(car.x, car.y);
    const n = Math.max(1, Math.ceil(Math.abs(dist) * 4));
    const sub = dist / n;
    let moved = 0;
    let blockedBy: Record<string, unknown> | null = null;
    for (let i = 0; i < n; i++) {
      const nx = round2(car.x + dx * sub);
      const ny = round2(car.y + dy * sub);
      const [cx, cy] = cellOf(nx, ny);
      const [ox, oy] = cellOf(car.x, car.y);
      if (cx !== ox || cy !== oy) {
        const what = this.blockerAt(cx, cy, car.id) ?? this.cornerBlocker(ox, oy, cx, cy, car.id);
        if (what) {
          blockedBy = what;
          // Stop at the last whole cell reached rather than part-way into a cell edge.
          moved = Math.trunc(round2(moved));
          car.x = round2(start.x + dx * moved);
          car.y = round2(start.y + dy * moved);
          break;
        }
      }
      car.x = nx;
      car.y = ny;
      moved += sub;
    }
    car.stats.distance += Math.abs(moved);
    const endCell = cellOf(car.x, car.y);
    if (endCell[0] !== startCell[0] || endCell[1] !== startCell[1]) this.arrivalEvents(car, events);
    return { moved, blockedBy };
  }

  /** Moving diagonally between cells must not squeeze between two blocked corners. */
  private cornerBlocker(ox: number, oy: number, cx: number, cy: number, self: string) {
    if (ox === cx || oy === cy) return null;
    const a = this.blockerAt(cx, oy, self);
    const b = this.blockerAt(ox, cy, self);
    return a && b ? a : null;
  }

  private blockerAt(x: number, y: number, self: string): Record<string, unknown> | null {
    if (this.walls.has(cellKey(x, y))) return { by: "wall" };
    const other = this.carAtCell(x, y, self);
    if (other) return { by: "agent", team: other.team };
    return null;
  }

  private carAtCell(x: number, y: number, except?: string): Car | undefined {
    for (const c of this.cars.values()) {
      if (!c.alive || c.id === except) continue;
      const [cx, cy] = cellOf(c.x, c.y);
      if (cx === x && cy === y) return c;
    }
    return undefined;
  }

  private arrivalEvents(car: Car, events: WorldEvent[]) {
    const on = this.itemOn(car.x, car.y);
    if (on === "gift") events.push({ kind: "agentEvent", carId: car.id, name: "canCollectGift" });
    if (on === "ammo") events.push({ kind: "agentEvent", carId: car.id, name: "canCollectAmmo" });
    if (on === "energy") events.push({ kind: "agentEvent", carId: car.id, name: "canCollectEnergy" });
  }

  private fire(car: Car, events: WorldEvent[]): FireResult {
    if (this.tick < car.protectedUntil) return { outcome: "refused", reason: "protected" };
    if (car.ammo <= 0) return { outcome: "refused", reason: "no_ammo" };
    if (this.tick < car.cooldownUntil) return { outcome: "refused", reason: "cooling_down" };
    car.ammo--;
    car.stats.shotsFired++;
    car.cooldownUntil = this.tick + secToTicks(this.rules.fireCooldownSec, this.rules.tickRate);

    // The bullet flies straight until the first wall or car (no range limit).
    const ray = this.castRay(car, Infinity, false);
    const from = { x: car.x, y: car.y };
    if (ray.car) {
      const target = ray.car;
      this.shots.push({ from, to: { x: target.x, y: target.y }, hit: true });
      car.lastShot = "hit";
      if (this.tick >= target.protectedUntil) this.damage(car, target, events);
      return { outcome: "hit", team: target.team };
    }
    this.shots.push({ from, to: ray.end, hit: false });
    car.lastShot = "miss";
    return { outcome: "miss" };
  }

  private damage(shooter: Car, target: Car, events: WorldEvent[]) {
    shooter.stats.hitsLanded++;
    target.stats.hitsTaken++;
    target.life = Math.max(0, target.life - this.rules.damage);
    events.push({
      kind: "agentEvent",
      carId: target.id,
      name: "hit",
      data: { side: this.sideOf(target, shooter), by: shooter.team },
    });
    const killed = target.life <= 0;
    events.push({ kind: "shotHit", shooter: shooter.id, target: target.id, killed, shooterX: shooter.x, targetX: target.x });
    if (killed) {
      shooter.stats.kills++;
      this.kill(target, shooter, events);
    }
  }

  /** Which side of the target the shooter is on, relative to the target's heading. */
  private sideOf(target: Car, shooter: Car): Side {
    const bearing = (Math.atan2(shooter.x - target.x, -(shooter.y - target.y)) * 180) / Math.PI;
    const rel = norm180(bearing - target.heading);
    if (Math.abs(rel) <= 45) return "front";
    if (Math.abs(rel) >= 135) return "back";
    return rel > 0 ? "right" : "left";
  }

  private kill(car: Car, killer: Car | null, events: WorldEvent[]) {
    car.alive = false;
    car.action = null;
    car.life = 0;
    car.stats.deaths++;
    car.respawnAt = this.tick + 1 + secToTicks(this.rules.respawnDelaySec, this.rules.tickRate);

    // Lose the most recently collected gifts; they go back to their home cells.
    const lost: Gift[] = [];
    for (let i = 0; i < this.rules.giftsLostOnDeath && car.gifts.length; i++) {
      const g = this.giftById(car.gifts.pop()!)!;
      g.heldBy = null;
      lost.push(g);
    }
    car.stats.giftsLost += lost.length;

    events.push({ kind: "death", carId: car.id, killer: killer?.id ?? null, x: car.x });
    events.push({ kind: "agentEvent", carId: car.id, name: "died", data: { killedBy: killer?.team ?? null } });
    for (const other of this.allCars()) {
      if (other.id === car.id) continue;
      const data: Record<string, unknown> = { team: car.team, killedBy: killer?.team ?? null, lostGift: lost.length > 0 };
      if (this.rules.revealItems && lost.length) data.giftHome = lost.map((g) => ({ x: g.home[0], y: g.home[1] }));
      events.push({ kind: "agentEvent", carId: other.id, name: "otherAgentDied", data });
    }
  }

  private respawn(car: Car, events: WorldEvent[]) {
    const spawn = this.freeSpawn();
    if (!spawn) return; // try again next tick
    car.alive = true;
    car.x = spawn[0];
    car.y = spawn[1];
    car.heading = this.headingTowardCentre(spawn);
    car.life = this.rules.maxLife;
    car.ammo = this.rules.startAmmo;
    car.lastShot = "none";
    car.cooldownUntil = 0;
    car.protectedUntil = this.tick + 1 + secToTicks(this.rules.protectionSec, this.rules.tickRate);
    events.push({ kind: "agentEvent", carId: car.id, name: "respawned", data: { position: { x: car.x, y: car.y } } });
  }

  // ---------- queries ----------

  /** Walk along the car's heading until something is hit. */
  private castRay(car: Car, range: number, seeItems: boolean) {
    const { dx, dy } = dirOf(car.heading);
    const [sx, sy] = cellOf(car.x, car.y);
    const stepLen = 0.05;
    const max = Math.min(range, (this.map.width + this.map.height) * 2);
    let lastCell = `${sx},${sy}`;
    for (let d = stepLen; d <= max + 0.5; d += stepLen) {
      const px = car.x + dx * d;
      const py = car.y + dy * d;
      const [cx, cy] = cellOf(px, py);
      const k = cellKey(cx, cy);
      if (k === lastCell) continue;
      lastCell = k;
      const dist = round2(Math.hypot(cx - car.x, cy - car.y));
      if (dist > range) break;
      if (this.walls.has(k)) return { type: "wall" as const, dist, end: { x: round2(px), y: round2(py) } };
      const other = this.carAtCell(cx, cy, car.id);
      if (other) return { type: "agent" as const, dist, car: other, end: { x: other.x, y: other.y } };
      if (seeItems) {
        const item = this.itemOn(cx, cy);
        if (item) return { type: item, dist, end: { x: cx, y: cy } };
      }
    }
    return { type: "none" as const, dist: null, end: { x: car.x + dx * max, y: car.y + dy * max } };
  }

  lineOfSight(car: Car): LineOfSight {
    const r = this.castRay(car, this.rules.sightRange, true);
    if (r.type === "none") return { type: "none", distance: null };
    if (r.type === "agent") return { type: "agent", distance: r.dist, team: r.car!.team };
    return { type: r.type, distance: r.dist };
  }

  private giftById(id: string) {
    return this.gifts.find((g) => g.id === id);
  }

  private giftAt(x: number, y: number) {
    const [cx, cy] = cellOf(x, y);
    return this.gifts.find((g) => !g.heldBy && g.home[0] === cx && g.home[1] === cy);
  }

  private pickupAt(x: number, y: number, type?: "ammo" | "energy") {
    const [cx, cy] = cellOf(x, y);
    return this.pickups.find((p) => p.x === cx && p.y === cy && (!type || p.type === type) && this.tick >= p.availableAt);
  }

  private itemOn(x: number, y: number): ItemType | null {
    if (this.giftAt(x, y)) return "gift";
    const p = this.pickupAt(x, y);
    return p ? p.type : null;
  }

  private freeSpawn(): [number, number] | null {
    const spawns = this.map.spawns;
    for (let i = 0; i < spawns.length; i++) {
      const s = spawns[(this.nextSpawn + i) % spawns.length];
      if (!this.carAtCell(s[0], s[1])) {
        this.nextSpawn = (this.nextSpawn + i + 1) % spawns.length;
        return [s[0], s[1]];
      }
    }
    return null;
  }

  /** Spawned cars face the nearest axis direction toward the middle of the map. */
  private headingTowardCentre([x, y]: [number, number]) {
    const dx = this.map.width / 2 - x;
    const dy = this.map.height / 2 - y;
    if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 90 : 270;
    return dy >= 0 ? 180 : 0;
  }

  private partialResult(car: Car, a: RunningAction): ActionResultValue {
    switch (a.name) {
      case "turn": return { heading: car.heading };
      case "move": return { moved: round2(Math.abs(a.done)) };
      case "idle": return "done";
      case "fire": return { outcome: "miss" };
      default: return "nothing_here";
    }
  }

  get timeLeft() {
    return Math.max(0, round2((this.matchTicks - this.tick) / this.rules.tickRate));
  }

  get giftsOnMap() {
    return this.gifts.filter((g) => !g.heldBy).length;
  }

  get totalGifts() {
    return this.gifts.length;
  }

  scoreboard(): Record<string, number> {
    const s: Record<string, number> = {};
    for (const c of this.allCars()) s[c.team] = c.gifts.length;
    return s;
  }

  itemLocations(): ItemLocation[] {
    const items: ItemLocation[] = this.gifts.filter((g) => !g.heldBy).map((g) => ({ type: "gift", x: g.home[0], y: g.home[1] }));
    for (const p of this.pickups) if (this.tick >= p.availableAt) items.push({ type: p.type, x: p.x, y: p.y });
    return items;
  }

  /** The state one agent sees this tick. */
  agentState(id: string): AgentState | null {
    const car = this.cars.get(id);
    if (!car) return null;
    const prot = this.tick < car.protectedUntil;
    return {
      tick: this.tick,
      position: { x: car.x, y: car.y },
      heading: car.heading,
      life: car.life,
      maxLife: this.rules.maxLife,
      ammo: car.ammo,
      fireReady: car.alive && !prot && car.ammo > 0 && this.tick >= car.cooldownUntil,
      lastShot: car.lastShot,
      myGifts: car.gifts.length,
      totalGifts: this.gifts.length,
      giftsLeft: this.giftsOnMap,
      timeLeft: this.timeLeft,
      lineOfSight: car.alive ? this.lineOfSight(car) : { type: "none", distance: null },
      standingOn: car.alive ? this.itemOn(car.x, car.y) ?? "none" : "none",
      busy: car.action !== null,
      alive: car.alive,
      protected: car.alive && prot,
      itemLocations: this.rules.revealItems ? this.itemLocations() : "hidden",
      scoreboard: this.rules.showScoreboard ? this.scoreboard() : "hidden",
    };
  }

  /** Everything the stage screen draws. */
  view(): WorldView {
    const cars: CarView[] = this.allCars().map((c) => ({
      id: c.id,
      team: c.team,
      x: c.x,
      y: c.y,
      heading: c.heading,
      life: c.life,
      maxLife: this.rules.maxLife,
      ammo: c.ammo,
      gifts: c.gifts.length,
      alive: c.alive,
      protected: c.alive && this.tick < c.protectedUntil,
      connected: c.connected,
    }));
    const items = [
      ...this.gifts.filter((g) => !g.heldBy).map((g) => ({ type: "gift" as const, x: g.home[0], y: g.home[1], id: g.id })),
      ...this.pickups.filter((p) => this.tick >= p.availableAt).map((p) => ({ type: p.type, x: p.x, y: p.y })),
    ];
    return {
      tick: this.tick,
      timeLeft: this.timeLeft,
      cars,
      items,
      shots: this.shots,
      totalGifts: this.gifts.length,
      giftsLeft: this.giftsOnMap,
    };
  }

  /** Per-team stats, unsorted. */
  stats(): TeamStats[] {
    return this.allCars().map((c) => ({ team: c.team, gifts: c.gifts.length, lifeLeft: c.alive ? c.life : 0, ...c.stats }));
  }

  /** Full serialisable copy of mutable state, for snapshots and replays. */
  snapshot() {
    return {
      tick: this.tick,
      cars: this.allCars().map((c) => structuredClone(c)),
      gifts: this.gifts.map((g) => ({ ...g })),
      pickups: this.pickups.map((p) => ({ ...p, availableAt: Number.isFinite(p.availableAt) ? p.availableAt : -1 })),
      nextSpawn: this.nextSpawn,
    };
  }

  restore(s: ReturnType<World["snapshot"]>) {
    this.tick = s.tick;
    this.cars = new Map(s.cars.map((c) => [c.id, structuredClone(c)]));
    this.order = s.cars.map((c) => c.id);
    this.gifts = s.gifts.map((g) => ({ ...g }));
    this.pickups = s.pickups.map((p) => ({ ...p, availableAt: p.availableAt === -1 ? Infinity : p.availableAt }));
    this.nextSpawn = s.nextSpawn;
  }
}

/** Rank teams: most gifts, then fewest deaths, then most hits landed, then most life left. */
export function rankStats(stats: TeamStats[]) {
  const sorted = [...stats].sort(
    (a, b) => b.gifts - a.gifts || a.deaths - b.deaths || b.hitsLanded - a.hitsLanded || b.lifeLeft - a.lifeLeft,
  );
  return sorted.map((s, i) => ({
    ...s,
    rank: i + 1,
    accuracy: s.shotsFired ? Math.round((s.hitsLanded / s.shotsFired) * 100) / 100 : 0,
  }));
}
