import type { IncomingMessage } from "node:http";
import type { NextFunction, Request, Response } from "express";
import { WebSocket } from "ws";
import type { AdminCommand, AdminState, ServerToAdmin } from "@lootbot/shared";

type Handler<T extends AdminCommand["type"]> = (cmd: Extract<AdminCommand, { type: T }>) => void | Promise<void>;

/**
 * The host's admin connection: checks the admin key, pushes the admin state whenever
 * something changes, and dispatches commands to registered handlers.
 */
export class AdminHub {
  private sockets = new Set<WebSocket>();
  private handlers = new Map<string, Handler<any>>();
  private pending = false;
  /** Commands run one at a time, in arrival order, so async ones cannot race. */
  private queue: Promise<void> = Promise.resolve();

  constructor(readonly key: string, private state: () => AdminState) {}

  /** True if the request carries the admin key (query `?key=` or header `x-admin-key`). */
  authorized(req: IncomingMessage) {
    const url = new URL(req.url ?? "/", "http://x");
    return url.searchParams.get("key") === this.key || req.headers["x-admin-key"] === this.key;
  }

  /** Express middleware for admin-only HTTP routes. */
  guard = (req: Request, res: Response, next: NextFunction) => {
    if (this.authorized(req)) return next();
    res.status(401).json({ error: "Admin key required." });
  };

  on<T extends AdminCommand["type"]>(type: T, fn: Handler<T>) {
    this.handlers.set(type, fn);
  }

  connect(ws: WebSocket, req: IncomingMessage) {
    if (!this.authorized(req)) {
      ws.close(4001, "Admin key required.");
      return;
    }
    this.sockets.add(ws);
    ws.on("close", () => this.sockets.delete(ws));
    ws.on("message", (raw) => {
      this.queue = this.queue.then(() => this.run(ws, raw.toString()));
    });
    this.sendTo(ws, this.state());
  }

  private async run(ws: WebSocket, raw: string) {
    let cmd: AdminCommand;
    try {
      cmd = JSON.parse(raw);
    } catch {
      return this.sendTo(ws, { type: "error", message: "Malformed command." });
    }
    const fn = this.handlers.get(cmd?.type);
    if (!fn) return this.sendTo(ws, { type: "error", message: `Unknown command "${cmd?.type}".` });
    try {
      await fn(cmd);
    } catch (e) {
      this.sendTo(ws, { type: "error", message: (e as Error).message });
    }
    this.changed();
  }

  /** Push fresh state to every admin page (batched to once per event-loop turn). */
  changed() {
    if (this.pending) return;
    this.pending = true;
    setImmediate(() => {
      this.pending = false;
      this.broadcast(this.state());
    });
  }

  broadcast(msg: ServerToAdmin) {
    const raw = JSON.stringify(msg);
    for (const ws of this.sockets) if (ws.readyState === WebSocket.OPEN) ws.send(raw);
  }

  private sendTo(ws: WebSocket, msg: ServerToAdmin) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }
}
