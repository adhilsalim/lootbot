import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocket } from "ws";
import {
  parseAgentMessage,
  type AgentInfo,
  type AgentStatus,
  type AgentToServer,
  type ConnectionTestResult,
  type JoinMsg,
  type ServerToAgent,
  type TeamProfileView,
} from "@lootbot/shared";
import type { Match } from "./match.js";

export interface AgentRecord {
  /** Also the car id in the match. */
  id: string;
  team: string;
  token: string | null;
  status: AgentStatus;
  ws: WebSocket | null;
  remote: string;
  profileId: string | null;
  profile: TeamProfileView | null;
  profileNotes: string[];
  test: ConnectionTestResult;
}

export interface LobbyEvents {
  change: [];
  /** A pong or other message the connection tester cares about. */
  agentMessage: [agent: AgentRecord, msg: AgentToServer];
  accepted: [agent: AgentRecord];
  removed: [agent: AgentRecord];
}

/** Looks up an uploaded profile by id when an agent joins (provided by the uploads module). */
export type ProfileResolver = (
  id: string,
  team: string,
) => Promise<{ profile: TeamProfileView; notes: string[] } | null>;

const MAX_TEAM_NAME = 20;
const newToken = () => `t_${randomBytes(16).toString("hex")}`;
const newId = () => `a_${randomBytes(4).toString("hex")}`;

export function randomJoinCode() {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  return Array.from(randomBytes(4), (b) => letters[b % letters.length]).join("");
}

/**
 * Agents joining over WebSocket: join code check, host approval, tokens, reconnects and kicks.
 * Also routes the match's per-agent messages to the right socket.
 */
export class Lobby extends EventEmitter<LobbyEvents> {
  readonly agents = new Map<string, AgentRecord>();
  /** Sockets of agents in the hidden practice room; their actions go to the tester. */
  readonly practice = new Set<string>();
  resolveProfile: ProfileResolver = async () => null;
  /** Default profile for a team that uploaded none (colour only). */
  defaultProfile: (team: string) => TeamProfileView = (team) => ({ team, icon: null, driver: null, passengers: [], clips: {}, color: "#888" });

  constructor(private match: Match, public joinCode: string) {
    super();
    match.on("agent", (carId, msg) => {
      const a = this.agents.get(carId);
      if (a && !this.practice.has(a.id)) this.send(a, msg);
    });
  }

  /** Handle a new agent WebSocket. */
  connect(ws: WebSocket, req: IncomingMessage) {
    const remote = req.socket.remoteAddress?.replace(/^::ffff:/, "") ?? "?";
    let agent: AgentRecord | null = null;

    ws.on("message", (raw) => {
      const msg = parseAgentMessage(raw.toString());
      if (!msg) return this.sendWs(ws, { type: "error", reason: "Malformed message." });

      if (msg.type === "join") {
        if (agent) return this.sendWs(ws, { type: "error", reason: "Already joined." });
        agent = this.join(ws, msg, remote);
        return;
      }
      if (!agent) return this.sendWs(ws, { type: "error", reason: "Send a join message first." });
      if (msg.type === "pong") return this.emit("agentMessage", agent, msg);

      // Every action must carry this car's token.
      if (agent.status !== "accepted" || msg.token !== agent.token) {
        return this.sendWs(ws, { type: "error", reason: "Invalid or missing token." });
      }
      if (this.practice.has(agent.id)) return this.emit("agentMessage", agent, msg);
      if (msg.type === "action") {
        this.match.receiveAction({ carId: agent.id, tick: msg.tick, name: msg.name, args: msg.args });
      } else if (msg.type === "stop") {
        this.match.receiveStop(agent.id);
      }
    });

    ws.on("close", () => {
      if (!agent || agent.ws !== ws) return;
      agent.ws = null;
      if (agent.status === "pending") {
        this.agents.delete(agent.id);
        this.emit("removed", agent);
      } else if (agent.status === "accepted") {
        // The car stands still until the same token reconnects.
        this.match.setConnected(agent.id, false);
      }
      this.emit("change");
    });
  }

  private join(ws: WebSocket, msg: JoinMsg, remote: string): AgentRecord | null {
    // Reconnect: the same token takes back the same car.
    if (msg.token) {
      const prev = [...this.agents.values()].find((a) => a.token === msg.token && a.status === "accepted");
      if (!prev) {
        this.sendWs(ws, { type: "joinResult", accepted: false, reason: "Unknown token." });
        ws.close();
        return null;
      }
      if (prev.ws && prev.ws !== ws) prev.ws.close(4000, "Replaced by a new connection.");
      prev.ws = ws;
      prev.remote = remote;
      this.match.setConnected(prev.id, true);
      this.sendWs(ws, { type: "joinResult", accepted: true, token: prev.token!, status: "reconnected" });
      this.emit("change");
      return prev;
    }

    if (msg.joinCode.trim().toUpperCase() !== this.joinCode.toUpperCase()) {
      this.sendWs(ws, { type: "joinResult", accepted: false, status: "declined", reason: "Wrong join code." });
      ws.close();
      return null;
    }
    const team = msg.teamName.trim();
    const problem = !team
      ? "Team name is required."
      : team.length > MAX_TEAM_NAME
        ? `Team name must be at most ${MAX_TEAM_NAME} characters.`
        : this.teamTaken(team)
          ? `Team name "${team}" is already taken.`
          : null;
    if (problem) {
      this.sendWs(ws, { type: "joinResult", accepted: false, status: "declined", reason: problem });
      ws.close();
      return null;
    }

    const agent: AgentRecord = {
      id: newId(),
      team,
      token: null,
      status: "pending",
      ws,
      remote,
      profileId: msg.profile?.id ?? null,
      profile: null,
      profileNotes: [],
      test: { status: "untested", avgMs: null, maxMs: null, detail: [] },
    };
    agent.profile = this.defaultProfile(team);
    if (agent.profileId) {
      // Uploaded files are looked up on disk; the preview fills in when ready.
      this.resolveProfile(agent.profileId, team).then((resolved) => {
        if (!resolved) agent.profileNotes.push("Profile upload not found; using defaults.");
        else {
          agent.profile = { ...resolved.profile, color: agent.profile?.color ?? resolved.profile.color };
          agent.profileNotes.push(...resolved.notes);
        }
        this.emit("change");
      });
    }

    this.agents.set(agent.id, agent);
    this.sendWs(ws, { type: "joinResult", accepted: false, status: "pending", reason: "Waiting for the host to accept." });
    this.emit("change");
    return agent;
  }

  private teamTaken(team: string) {
    const t = team.toLowerCase();
    return [...this.agents.values()].some((a) => (a.status === "pending" || a.status === "accepted") && a.team.toLowerCase() === t);
  }

  accept(id: string) {
    const a = this.require(id);
    if (a.status !== "pending") throw new Error(`${a.team} is not pending.`);
    a.status = "accepted";
    a.token = newToken();
    this.send(a, { type: "joinResult", accepted: true, token: a.token, status: "accepted" });
    this.emit("accepted", a);
    this.emit("change");
  }

  decline(id: string, reason = "Declined by the host.") {
    const a = this.require(id);
    if (a.status !== "pending") throw new Error(`${a.team} is not pending.`);
    a.status = "declined";
    this.send(a, { type: "joinResult", accepted: false, status: "declined", reason });
    a.ws?.close();
    this.agents.delete(id);
    this.emit("removed", a);
    this.emit("change");
  }

  /** Remove an agent at any stage. Its car leaves the map and its gifts go home. */
  kick(id: string) {
    const a = this.require(id);
    a.status = "kicked";
    this.send(a, { type: "event", name: "kicked", tick: this.match.world?.tick ?? 0, reason: "Removed by the host." });
    a.ws?.close();
    this.match.removeCar(id);
    this.agents.delete(id);
    this.emit("removed", a);
    this.emit("change");
  }

  accepted() {
    return [...this.agents.values()].filter((a) => a.status === "accepted");
  }

  info(latency: Map<string, number> = new Map()): AgentInfo[] {
    return [...this.agents.values()].map((a) => ({
      id: a.id,
      team: a.team,
      status: a.status,
      connected: a.ws?.readyState === WebSocket.OPEN,
      remote: a.remote,
      test: a.test,
      latencyMs: latency.get(a.id) ?? null,
      profile: a.profile,
      profileNotes: a.profileNotes,
    }));
  }

  send(a: AgentRecord, msg: ServerToAgent) {
    if (a.ws) this.sendWs(a.ws, msg);
  }

  private sendWs(ws: WebSocket, msg: ServerToAgent) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  private require(id: string) {
    const a = this.agents.get(id);
    if (!a) throw new Error("No such agent.");
    return a;
  }
}
