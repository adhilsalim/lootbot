import { createApp, lanAddresses } from "./app.js";

const port = Number(process.env.PORT ?? 8080);
const app = await createApp({ port });
const lan = lanAddresses(app.port);
console.log(`Lootbot server running.
  Admin page:   http://localhost:${app.port}/admin?key=${app.adminKey}
  Stage screen: http://localhost:${app.port}/stage
  Agents:       ${lan.join("  ")}
  Join code:    ${app.lobby.joinCode}`);

// `--demo [map.json]`: start a test run straight away with built-in bots, for checking the stage screen.
const demoIdx = process.argv.indexOf("--demo");
if (demoIdx !== -1) {
  const file = process.argv[demoIdx + 1] ?? "level-1-open-field.json";
  await app.startTestRun(file, 600);
  console.log(`Demo match started on ${file}.`);
}

const shutdown = () => app.close().then(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
