import { readFileSync } from "node:fs";
import path from "node:path";
import { createApp, ensureProfile } from "./app.js";

const port = Number(process.env.PORT ?? 8080);
const app = await createApp({ port });
console.log(`Lootbot server on http://localhost:${app.port}  (admin: /admin, stage: /stage)`);

// `--demo [map.json]`: start a match straight away with built-in bots, for checking the stage screen.
const demoIdx = process.argv.indexOf("--demo");
if (demoIdx !== -1) {
  const file = process.argv[demoIdx + 1] ?? "level-1-open-field.json";
  const map = JSON.parse(readFileSync(path.join(app.dirs.maps, path.basename(file)), "utf8"));
  app.match.setMap(map);
  const names = ["Falcon", "Eagle", "Hawk", "Owl"].slice(0, map.spawns.length);
  const teams = names.map((team, i) => {
    ensureProfile(app.profiles, team);
    app.bots.add(`demo${i}`, i + 1);
    return { carId: `demo${i}`, team };
  });
  app.broadcastStage({ type: "profiles", profiles: [...app.profiles.values()] });
  app.match.start(teams);
  console.log(`Demo match started on "${map.name}" with ${teams.length} bots.`);
}

const shutdown = () => app.close().then(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
