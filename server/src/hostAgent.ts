/**
 * Host-run fallback: run a team's agent on the game laptop when their own laptop fails.
 *
 *   npm run host-agent -- path/to/bot.py Falcon [--python python3]
 *
 * Takes the team's token from the running server (so the bot drives the same car),
 * points it at ws://localhost, and runs it as a plain Python process.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT_DIR } from "./app.js";

const args = process.argv.slice(2);
const pyIdx = args.indexOf("--python");
const pythonArg = pyIdx !== -1 ? args.splice(pyIdx, 2)[1] : null;
const [botFile, team] = args;
if (!botFile || !team) {
  console.error("Usage: npm run host-agent -- path/to/bot.py <team name> [--python python3]");
  process.exit(2);
}

const infoFile = path.join(ROOT_DIR, ".lootbot-host.json");
if (!existsSync(infoFile)) {
  console.error("No running server found (start it with `npm start` first).");
  process.exit(1);
}
const { port, adminKey } = JSON.parse(readFileSync(infoFile, "utf8"));
const res = await fetch(`http://localhost:${port}/api/admin/agent-token?team=${encodeURIComponent(team)}`, {
  headers: { "x-admin-key": adminKey },
}).catch(() => null);
if (!res?.ok) {
  console.error(`Could not reach the server on port ${port}.`);
  process.exit(1);
}
const info = (await res.json()) as { token: string | null; joinCode: string; team: string | null };

// Keep the token next to nothing else of the team's: one folder per team under hostrun/.
const safe = team.replace(/[^A-Za-z0-9]/g, "_");
const workDir = path.join(ROOT_DIR, "hostrun", safe);
mkdirSync(workDir, { recursive: true });
const tokenFile = path.join(workDir, "token");
if (info.token) {
  writeFileSync(tokenFile, info.token);
  console.log(`Taking over ${info.team}'s car on this laptop.`);
} else {
  writeFileSync(tokenFile, "");
  console.log(`${team} has not been accepted yet: the bot will join as a new team (accept it in the admin page).`);
}

const venvPython = path.join(ROOT_DIR, "kits/python/.venv/bin/python");
const python = pythonArg ?? (existsSync(venvPython) ? venvPython : "python3");
const bot = path.resolve(botFile);
const child = spawn(python, ["-u", bot], {
  cwd: path.dirname(bot),
  stdio: "inherit",
  env: {
    ...process.env,
    LOOTBOT_SERVER_OVERRIDE: `ws://localhost:${port}`,
    LOOTBOT_JOIN_CODE: info.joinCode,
    LOOTBOT_TOKEN_FILE: tokenFile,
    LOOTBOT_TEAM: info.team ?? team,
    // Lets the bot import the kit even if it was never pip-installed here.
    PYTHONPATH: [path.join(ROOT_DIR, "kits/python"), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
  },
});
process.on("SIGINT", () => child.kill("SIGINT"));
child.on("exit", (code) => process.exit(code ?? 0));
