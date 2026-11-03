/**
 * Terminal simulation: runs built-in bots on a map with no network and no graphics.
 *   npx tsx server/src/game/sim.ts [maps/level1.json] [teams=4] [seconds=60]
 */
import { readFileSync } from "node:fs";
import { cellKey, wallSet, type MapFile } from "@lootbot/shared";
import { rankStats, World } from "./world.js";
import { wanderBot } from "./bots.js";

const [mapPath = "maps/level-1-open-field.json", teamsArg = "4", secondsArg = "60"] = process.argv.slice(2);
const map: MapFile = JSON.parse(readFileSync(mapPath, "utf8"));
const world = new World(map, { matchSeconds: Number(secondsArg) });
const names = ["Falcon", "Eagle", "Hawk", "Owl", "Kite", "Raven", "Swift", "Heron"];
const bots = new Map<string, ReturnType<typeof wanderBot>>();
for (let i = 0; i < Number(teamsArg); i++) {
  if (world.addCar(`c${i}`, names[i % names.length])) bots.set(`c${i}`, wanderBot(i + 1));
}

const walls = wallSet(map);
function draw() {
  const v = world.view();
  const rows: string[] = [];
  for (let y = 0; y < map.height; y++) {
    let row = "";
    for (let x = 0; x < map.width; x++) {
      const car = v.cars.find((c) => c.alive && Math.round(c.x) === x && Math.round(c.y) === y);
      const item = v.items.find((i) => i.x === x && i.y === y);
      row += car ? car.team[0] : walls.has(cellKey(x, y)) ? "#" : item ? { gift: "*", ammo: "a", energy: "e" }[item.type] : ".";
    }
    rows.push(row);
  }
  const score = v.cars.map((c) => `${c.team}:${c.gifts}g ${c.life}hp`).join("  ");
  return `${rows.join("\n")}\ntick ${v.tick}  time ${v.timeLeft}s  gifts left ${v.giftsLeft}\n${score}`;
}

while (world.tick < world.matchTicks && world.giftsOnMap > 0) {
  for (const [id, bot] of bots) {
    const s = world.agentState(id);
    const a = s && bot(s);
    if (a) world.submit(id, a.name, a.args);
  }
  world.step();
  if (world.tick % (world.rules.tickRate * 10) === 0) console.log(`\n${draw()}`);
}
console.log(`\n${draw()}\n`);
console.table(rankStats(world.stats()));
