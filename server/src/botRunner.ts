import type { Match } from "./match.js";
import { wanderBot } from "./game/bots.js";

/**
 * Drives in-process built-in bots inside a match: answers each state message
 * the way a real agent would. Used for map test runs and the demo mode.
 */
export class BotRunner {
  private bots = new Map<string, ReturnType<typeof wanderBot>>();

  constructor(private match: Match) {
    match.on("agent", (carId, msg) => {
      const bot = this.bots.get(carId);
      if (!bot || msg.type !== "state") return;
      const a = bot(msg);
      if (a) match.receiveAction({ carId, tick: msg.tick, name: a.name, args: a.args });
    });
  }

  add(carId: string, seed: number) {
    this.bots.set(carId, wanderBot(seed));
  }

  has(carId: string) {
    return this.bots.has(carId);
  }

  clear() {
    this.bots.clear();
  }
}
