import type { ActionName, AgentState } from "@lootbot/shared";

export interface BotAction { name: ActionName; args: number[] }

/**
 * A simple built-in agent: collects what it stands on, shoots cars ahead, avoids walls
 * and otherwise wanders. Used for map test runs and terminal simulations.
 */
export function wanderBot(seed = 1) {
  let rnd = seed >>> 0 || 1;
  const random = () => {
    // xorshift32: deterministic so test runs are repeatable.
    rnd ^= rnd << 13;
    rnd ^= rnd >>> 17;
    rnd ^= rnd << 5;
    return (rnd >>> 0) / 0xffffffff;
  };
  return (s: AgentState): BotAction | null => {
    if (!s.alive || s.busy) return null;
    if (s.standingOn === "gift") return { name: "collectGift", args: [] };
    if (s.standingOn === "ammo") return { name: "collectAmmo", args: [] };
    if (s.standingOn === "energy" && s.life < s.maxLife) return { name: "collectEnergy", args: [] };
    const los = s.lineOfSight;
    if (los.type === "agent" && s.fireReady) return { name: "fire", args: [] };
    if ((los.type === "wall" || los.type === "agent") && (los.distance ?? 99) <= 1) {
      return { name: "turn", args: [random() < 0.5 ? 90 : -90] };
    }
    if (los.type === "gift" || los.type === "ammo" || los.type === "energy") {
      return { name: "move", args: [los.distance ?? 1] };
    }
    if (random() < 0.15) return { name: "turn", args: [random() < 0.5 ? 90 : -90] };
    return { name: "move", args: [1] };
  };
}
