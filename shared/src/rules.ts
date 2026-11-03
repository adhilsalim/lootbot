/** Per-map level rules. Every number in the game rules is a default that a map can override. */
export interface Rules {
  /** Send `itemLocations` to agents (and reveal returned-gift home cells). */
  revealItems: boolean;
  /** Send every team's gift count to agents. */
  showScoreboard: boolean;
  /** How far line of sight reaches, in cells. */
  sightRange: number;
  startLife: number;
  maxLife: number;
  /** Life removed by one hit. */
  damage: number;
  startAmmo: number;
  maxAmmo: number;
  /** Bullets added by one ammo pickup (capped at maxAmmo). */
  ammoPerPickup: number;
  fireCooldownSec: number;
  energyPerDrink: number;
  /** Seconds before an ammo pickup reappears. `null` = never. */
  ammoRespawnSec: number | null;
  /** Seconds before an energy drink reappears. `null` = never. */
  energyRespawnSec: number | null;
  /** Seconds a dead car waits before respawning. */
  respawnDelaySec: number;
  /** Seconds after respawn during which the car cannot be damaged or fire. */
  protectionSec: number;
  /** Gifts a car loses (sent home) when it dies. */
  giftsLostOnDeath: number;
  matchSeconds: number;
  /** Ticks per second. */
  tickRate: number;
  /** Degrees a car turns per tick. */
  turnPerTick: number;
  /** Cells a car moves per tick. */
  movePerTick: number;
}

export const DEFAULT_RULES: Readonly<Rules> = Object.freeze({
  revealItems: true,
  showScoreboard: true,
  sightRange: 10,
  startLife: 100,
  maxLife: 100,
  damage: 25,
  startAmmo: 5,
  maxAmmo: 10,
  ammoPerPickup: 5,
  fireCooldownSec: 1,
  energyPerDrink: 30,
  ammoRespawnSec: 20,
  energyRespawnSec: 20,
  respawnDelaySec: 3,
  protectionSec: 2,
  giftsLostOnDeath: 1,
  matchSeconds: 600,
  tickRate: 10,
  turnPerTick: 45,
  movePerTick: 1,
});

/** Fill in any rule a map leaves out with its default. */
export function resolveRules(partial: Partial<Rules> | undefined): Rules {
  return { ...DEFAULT_RULES, ...(partial ?? {}) };
}

/** Convert seconds to whole ticks at the given tick rate (at least 1 for positive values). */
export function secToTicks(sec: number, tickRate: number): number {
  if (sec <= 0) return 0;
  return Math.max(1, Math.round(sec * tickRate));
}
