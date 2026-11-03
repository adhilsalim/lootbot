import { createServer, type IncomingMessage, type Server } from "node:http";
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Duplex } from "node:stream";
import express from "express";
import QRCode from "qrcode";
import { WebSocketServer, WebSocket } from "ws";
import type { AdminState, MapFile, ServerToStage, TeamProfileView } from "@lootbot/shared";
import { Match, type IntroTiming } from "./match.js";
import { BotRunner } from "./botRunner.js";
import { colorFor } from "./teamColors.js";
import { Lobby, randomJoinCode } from "./lobby.js";
import { AdminHub } from "./adminHub.js";
import { MapStore } from "./maps.js";
import { ConnectionTester, type TestOptions } from "./connectionTest.js";

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export interface AppOptions {
  port?: number;
  rootDir?: string;
  timing?: Partial<IntroTiming>;
  joinCode?: string;
  adminKey?: string;
  test?: Partial<TestOptions>;
  /** Milliseconds between background pings (0 = off). */
  pingEveryMs?: number;
}

/** Handles one WebSocket path (e.g. `/ws/stage`). */
export type SocketHandler = (ws: WebSocket, req: IncomingMessage) => void;

export type App = Awaited<ReturnType<typeof createApp>>;

/** LAN addresses agents can use to reach this laptop. */
export function lanAddresses(port: number) {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === "IPv4" && !ni.internal) out.push(`ws://${ni.address}:${port}`);
    }
  }
  return out.length ? out : [`ws://localhost:${port}`];
}

export async function createApp(opts: AppOptions = {}) {
  const root = opts.rootDir ?? ROOT_DIR;
  const dirs = {
    root,
    maps: path.join(root, "maps"),
    matches: path.join(root, "matches"),
    uploads: path.join(root, "uploads"),
    web: path.join(root, "web/dist"),
  };

  const ex = express();
  ex.use(express.json({ limit: "2mb" }));
  const http: Server = createServer(ex);
  const match = new Match(opts.timing);
  const bots = new BotRunner(match);
  const maps = new MapStore(dirs.maps);
  /** Profiles of every team on the stage right now, keyed by team name. */
  const profiles = new Map<string, TeamProfileView>();
  const lobby = new Lobby(match, opts.joinCode ?? process.env.LOOTBOT_JOIN_CODE ?? randomJoinCode());
  let port = opts.port ?? 8080;
  let mapFile: string | null = null;
  let testRun = false;
  let volume = 0.8;
  let colorIndex = 0;

  // ---------- WebSocket routing by path ----------
  const routes = new Map<string, SocketHandler>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  http.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://x");
    const handler = routes.get(url.pathname);
    if (!handler) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => handler(ws, req));
  });

  // ---------- stage screens ----------
  const stages = new Set<WebSocket>();
  const broadcastStage = (msg: ServerToStage) => {
    const raw = JSON.stringify(msg);
    for (const ws of stages) if (ws.readyState === WebSocket.OPEN) ws.send(raw);
  };
  const stageHandlers: ((ws: WebSocket, msg: any) => void)[] = [];
  match.on("stage", broadcastStage);
  routes.set("/ws/stage", (ws) => {
    stages.add(ws);
    ws.on("close", () => stages.delete(ws));
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        for (const h of stageHandlers) h(ws, msg);
      } catch {
        // ignore malformed
      }
    });
    const send = (m: ServerToStage) => ws.send(JSON.stringify(m));
    send({ type: "hello", stage: match.stage, map: match.map, rules: match.rules, profiles: [...profiles.values()] });
    send({ type: "volume", value: volume });
    if (match.world) send({ type: "world", world: match.world.view() });
    if (match.stage === "stats" && match.lastStats) {
      send({ type: "stats", stats: match.lastStats, winner: match.lastStats[0]?.team ?? null });
    }
  });

  /** Rebuild the stage's team list from accepted agents (or test-run bots). */
  const syncProfiles = () => {
    if (testRun) return;
    profiles.clear();
    for (const a of lobby.accepted()) if (a.profile) profiles.set(a.team, a.profile);
    broadcastStage({ type: "profiles", profiles: [...profiles.values()] });
  };

  // ---------- agents ----------
  lobby.defaultProfile = (team) => ({ team, icon: null, driver: null, passengers: [], clips: {}, color: "#888" });
  lobby.on("accepted", (a) => {
    if (a.profile) a.profile.color = colorFor(colorIndex++);
  });
  routes.set("/agent", (ws, req) => lobby.connect(ws, req));
  routes.set("/", (ws, req) => lobby.connect(ws, req));

  // ---------- admin ----------
  const adminKey = opts.adminKey ?? process.env.LOOTBOT_ADMIN_KEY ?? randomBytes(6).toString("hex");
  let mapList = await maps.list();
  const adminState = (): AdminState => ({
    type: "state",
    stage: match.stage,
    joinCode: lobby.joinCode,
    addresses: lanAddresses(port),
    agents: lobby.info(tester.latency),
    mapFile,
    map: match.map,
    rules: match.rules,
    maps: mapList,
    timeLeft: match.world ? match.world.timeLeft : null,
    volume,
    stats: match.lastStats,
    testRun,
  });
  const admin = new AdminHub(adminKey, adminState);
  routes.set("/ws/admin", (ws, req) => admin.connect(ws, req));

  // ---------- connection test ----------
  const tester = new ConnectionTester(lobby, opts.test, () => admin.changed());
  const testing = new Set<string>();
  const runTest = async (id: string) => {
    const a = lobby.agents.get(id);
    if (!a || a.status !== "accepted") throw new Error("Only accepted agents can be tested.");
    if (!a.ws) throw new Error(`${a.team} is not connected.`);
    if (match.stage !== "lobby" && match.stage !== "ready") throw new Error("Tests run only in the lobby or ready check.");
    if (testing.has(id)) return;
    testing.add(id);
    const rules = match.rules;
    if (rules && !opts.test?.tickWindowMs) tester.setTickWindow(1000 / rules.tickRate);
    try {
      await tester.run(a);
    } finally {
      testing.delete(id);
    }
  };
  /** Tests run in the background so admin commands are not held up. */
  const runTestInBackground = (id: string) => {
    runTest(id).catch((e) => admin.broadcast({ type: "error", message: (e as Error).message }));
  };
  lobby.on("accepted", (a) => {
    if (match.stage === "lobby" || match.stage === "ready") runTestInBackground(a.id);
  });
  match.on("stageChange", (stage) => {
    if (stage !== "ready") return;
    for (const a of lobby.accepted()) if (a.ws && a.test.status === "untested") runTestInBackground(a.id);
  });
  const pingTimer = opts.pingEveryMs === 0 ? null : setInterval(() => tester.pingAll(), opts.pingEveryMs ?? 5000);
  lobby.on("change", () => {
    syncProfiles();
    admin.changed();
  });
  match.on("stageChange", () => admin.changed());
  // Admin timer refresh: once a second is plenty.
  let lastSecond = -1;
  match.on("tick", (world) => {
    const s = Math.ceil(world.timeLeft);
    if (s !== lastSecond) {
      lastSecond = s;
      admin.changed();
    }
  });

  const refreshMaps = async () => {
    mapList = await maps.list();
    admin.changed();
  };

  const selectMap = async (file: string) => {
    const map: MapFile = await maps.load(file);
    // Keep the host's chosen match length across map changes; other rules come from the map.
    const len = match.overrides.matchSeconds;
    match.setMap(map, len ? { matchSeconds: len } : {});
    mapFile = file;
  };

  /** End a built-in-bot test run and restore the real team list. */
  const endTestRun = () => {
    if (!testRun) return;
    testRun = false;
    bots.clear();
    syncProfiles();
  };

  /** Drop built-in bots onto a map and play it (map builder "Test run"). */
  const startTestRun = async (file: string, seconds = 60) => {
    if (match.stage !== "lobby" && match.stage !== "ready") throw new Error("Finish or abort the current match first.");
    const map: MapFile = await maps.load(file);
    match.setMap(map, { matchSeconds: seconds });
    mapFile = file;
    testRun = true;
    bots.clear();
    profiles.clear();
    const names = ["Bot Falcon", "Bot Eagle", "Bot Hawk", "Bot Owl"].slice(0, Math.min(4, map.spawns.length));
    const teams = names.map((team, i) => {
      profiles.set(team, { team, icon: null, driver: null, passengers: [], clips: {}, color: colorFor(i) });
      bots.add(`bot${i}`, i + 1);
      return { carId: `bot${i}`, team };
    });
    broadcastStage({ type: "profiles", profiles: [...profiles.values()] });
    match.start(teams);
    match.skipIntro();
  };
  match.on("end", () => {
    if (testRun) bots.clear();
  });

  admin.on("accept", (c) => lobby.accept(c.id));
  admin.on("decline", (c) => lobby.decline(c.id, c.reason));
  admin.on("kick", (c) => lobby.kick(c.id));
  admin.on("selectMap", (c) => selectMap(c.file));
  admin.on("setRules", (c) => match.setOverrides(c.rules));
  admin.on("toReady", () => match.toReady());
  admin.on("toLobby", () => {
    match.toLobby();
    endTestRun();
  });
  admin.on("start", (c) => {
    endTestRun();
    const ready = lobby.accepted().filter((a) => a.ws && (c.override || a.test.status === "green" || a.test.status === "amber"));
    if (!ready.length) throw new Error(c.override ? "No connected teams." : "No team has passed the connection test (use override to start anyway).");
    syncProfiles();
    match.start(ready.map((a) => ({ carId: a.id, team: a.team })));
  });
  admin.on("runTest", (c) => {
    const a = lobby.agents.get(c.id);
    if (!a?.ws) throw new Error("Agent is not connected.");
    runTestInBackground(c.id);
  });
  admin.on("skipIntro", () => match.skipIntro());
  admin.on("pause", () => match.pause());
  admin.on("resume", () => match.resume());
  admin.on("abort", () => {
    match.abort();
    endTestRun();
  });
  admin.on("testRun", (c) => startTestRun(c.file));
  admin.on("volume", (c) => {
    volume = Math.max(0, Math.min(1, c.value));
    broadcastStage({ type: "volume", value: volume });
  });

  // ---------- HTTP ----------
  ex.get("/api/health", (_req, res) => res.json({ ok: true, stage: match.stage }));
  ex.get("/api/admin/qr", admin.guard, async (req, res) => {
    const svg = await QRCode.toString(String(req.query.text ?? ""), { type: "svg", margin: 1 });
    res.type("image/svg+xml").send(svg);
  });
  ex.use("/uploads", express.static(dirs.uploads, { maxAge: "1h" }));
  if (existsSync(dirs.web)) {
    ex.use(express.static(dirs.web));
    ex.get(["/admin", "/stage", "/"], (_req, res) => res.sendFile(path.join(dirs.web, "index.html")));
  }

  await new Promise<void>((resolve) => http.listen(port, resolve));
  const addr = http.address();
  if (typeof addr === "object" && addr) port = addr.port;

  return {
    http,
    express: ex,
    match,
    bots,
    lobby,
    admin,
    tester,
    runTest,
    maps,
    profiles,
    port,
    dirs,
    adminKey,
    broadcastStage,
    syncProfiles,
    refreshMaps,
    selectMap,
    startTestRun,
    route: (p: string, h: SocketHandler) => routes.set(p, h),
    onStageMessage: (h: (ws: WebSocket, msg: any) => void) => stageHandlers.push(h),
    setTestRun: (on: boolean) => {
      testRun = on;
      admin.changed();
    },
    close: () =>
      new Promise<void>((resolve) => {
        match.abort();
        if (pingTimer) clearInterval(pingTimer);
        for (const ws of wss.clients) ws.terminate();
        http.close(() => resolve());
      }),
  };
}
