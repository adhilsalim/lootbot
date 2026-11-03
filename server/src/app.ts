import { createServer, type IncomingMessage, type Server } from "node:http";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Duplex } from "node:stream";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import type { ServerToStage, TeamProfileView } from "@lootbot/shared";
import { Match, type IntroTiming } from "./match.js";
import { BotRunner } from "./botRunner.js";
import { colorFor } from "./teamColors.js";

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export interface AppOptions {
  port?: number;
  rootDir?: string;
  timing?: Partial<IntroTiming>;
}

export interface App {
  http: Server;
  match: Match;
  bots: BotRunner;
  /** Profiles of every team taking part, keyed by team name. */
  profiles: Map<string, TeamProfileView>;
  port: number;
  dirs: { root: string; maps: string; matches: string; uploads: string; web: string };
  broadcastStage(msg: ServerToStage): void;
  close(): Promise<void>;
}

/** Handles one WebSocket path (e.g. `/stage`). */
export type SocketHandler = (ws: WebSocket, req: IncomingMessage) => void;

export async function createApp(opts: AppOptions = {}): Promise<App & { route(path: string, h: SocketHandler): void; express: express.Express }> {
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
  const http = createServer(ex);
  const match = new Match(opts.timing);
  const bots = new BotRunner(match);
  const profiles = new Map<string, TeamProfileView>();

  // ---------- WebSocket routing by path ----------
  const routes = new Map<string, SocketHandler>();
  const wss = new WebSocketServer({ noServer: true });
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
  match.on("stage", broadcastStage);
  routes.set("/ws/stage", (ws) => {
    stages.add(ws);
    ws.on("close", () => stages.delete(ws));
    const hello: ServerToStage = {
      type: "hello",
      stage: match.stage,
      map: match.map,
      rules: match.rules,
      profiles: [...profiles.values()],
    };
    ws.send(JSON.stringify(hello));
    if (match.world) ws.send(JSON.stringify({ type: "world", world: match.world.view() } satisfies ServerToStage));
    if (match.stage === "stats" && match.lastStats) {
      ws.send(JSON.stringify({ type: "stats", stats: match.lastStats, winner: match.lastStats[0]?.team ?? null } satisfies ServerToStage));
    }
  });

  // ---------- static web app ----------
  ex.get("/api/health", (_req, res) => res.json({ ok: true, stage: match.stage }));
  if (existsSync(dirs.web)) {
    ex.use(express.static(dirs.web));
    ex.get(["/admin", "/stage", "/"], (_req, res) => res.sendFile(path.join(dirs.web, "index.html")));
  }

  await new Promise<void>((resolve) => http.listen(opts.port ?? 8080, resolve));
  const addr = http.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port ?? 8080;

  return {
    http,
    express: ex,
    match,
    bots,
    profiles,
    port,
    dirs,
    broadcastStage,
    route: (p, h) => routes.set(p, h),
    close: () =>
      new Promise<void>((resolve) => {
        match.abort();
        for (const ws of wss.clients) ws.terminate();
        http.close(() => resolve());
      }),
  };
}

/** Give a team a default profile (colour only) if it has none yet. */
export function ensureProfile(profiles: Map<string, TeamProfileView>, team: string): TeamProfileView {
  let p = profiles.get(team);
  if (!p) {
    p = { team, icon: null, driver: null, passengers: [], clips: {}, color: colorFor(profiles.size) };
    profiles.set(team, p);
  }
  return p;
}
