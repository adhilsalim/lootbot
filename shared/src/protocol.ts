/**
 * Agent ⇄ server messages. Every message is a JSON object with a `type` field, sent over
 * one WebSocket per agent at `ws://<host>:<port>/agent`.
 */

export type ActionName =
  | "turn"
  | "move"
  | "fire"
  | "collectGift"
  | "collectAmmo"
  | "collectEnergy"
  | "idle";

export const ACTION_NAMES: readonly ActionName[] = [
  "turn", "move", "fire", "collectGift", "collectAmmo", "collectEnergy", "idle",
];

export type Side = "front" | "back" | "left" | "right";
export type SightType = "wall" | "gift" | "ammo" | "energy" | "agent" | "none";
export type ItemType = "gift" | "ammo" | "energy";

export interface Vec { x: number; y: number }

export interface LineOfSight {
  type: SightType;
  /** Distance in cells to the thing seen; `null` when nothing is in range. */
  distance: number | null;
  /** Team name when `type` is `agent`. */
  team?: string;
}

export interface ItemLocation { type: ItemType; x: number; y: number }

/** Sent to every agent once per tick. */
export interface AgentState {
  tick: number;
  position: Vec;
  heading: number;
  life: number;
  maxLife: number;
  ammo: number;
  fireReady: boolean;
  lastShot: "hit" | "miss" | "none";
  myGifts: number;
  totalGifts: number;
  giftsLeft: number;
  timeLeft: number;
  lineOfSight: LineOfSight;
  standingOn: ItemType | "none";
  busy: boolean;
  alive: boolean;
  protected: boolean;
  itemLocations: ItemLocation[] | "hidden";
  scoreboard: Record<string, number> | "hidden";
}

export type FireResult =
  | { outcome: "hit"; team: string }
  | { outcome: "miss" }
  | { outcome: "refused"; reason: "no_ammo" | "cooling_down" | "protected" };

export type ActionResultValue =
  | { heading: number } // turn
  | { moved: number } // move
  | FireResult // fire
  | "ok" | "nothing_here" // collect*
  | "done"; // idle

export type AgentEventName =
  | "blocked"
  | "hit"
  | "canCollectGift"
  | "canCollectAmmo"
  | "canCollectEnergy"
  | "died"
  | "otherAgentDied"
  | "respawned"
  | "gameStarted"
  | "gamePaused"
  | "gameResumed"
  | "gameEnded"
  | "kicked";

// ---------- agent → server ----------

export interface JoinMsg {
  type: "join";
  joinCode: string;
  teamName: string;
  /** Id returned by `POST /api/profile` after uploading files over HTTP. */
  profile?: { id: string } | null;
  /** Token from an earlier session; reconnects to the same car. */
  token?: string;
}
export interface ActionMsg {
  type: "action";
  token: string;
  tick: number;
  name: ActionName;
  args: number[];
}
export interface StopMsg { type: "stop"; token: string }
export interface PongMsg { type: "pong"; id: number }

export type AgentToServer = JoinMsg | ActionMsg | StopMsg | PongMsg;

// ---------- server → agent ----------

export interface JoinResultMsg {
  type: "joinResult";
  accepted: boolean;
  token?: string;
  reason?: string;
  /** `pending` while the host has not decided yet. */
  status?: "pending" | "accepted" | "declined" | "reconnected";
}
export interface PingMsg { type: "ping"; id: number }
export interface StateMsg extends AgentState {
  type: "state";
  /** True during the connection test; the agent should still reply normally. */
  practice?: boolean;
}
export interface ActionResultMsg {
  type: "actionResult";
  tick: number;
  name: ActionName;
  result: ActionResultValue;
  /** True if cancelled with `stop`. */
  stopped?: boolean;
  practice?: boolean;
}
export interface EventMsg {
  type: "event";
  name: AgentEventName;
  tick: number;
  [extra: string]: unknown;
}
/** Connection test: the server asks the agent to perform an action in the practice room. */
export interface TestRequestMsg {
  type: "testRequest";
  name: ActionName;
  args: number[];
}
export interface ErrorMsg { type: "error"; reason: string }

export type ServerToAgent =
  | JoinResultMsg
  | PingMsg
  | StateMsg
  | ActionResultMsg
  | EventMsg
  | TestRequestMsg
  | ErrorMsg;

/** Parse and minimally validate a message from an agent. Returns null if malformed. */
export function parseAgentMessage(raw: string): AgentToServer | null {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return null;
  switch (msg.type) {
    case "join":
      if (typeof msg.joinCode !== "string" || typeof msg.teamName !== "string") return null;
      return msg;
    case "action":
      if (typeof msg.token !== "string" || typeof msg.tick !== "number") return null;
      if (!ACTION_NAMES.includes(msg.name)) return null;
      if (msg.args === undefined) msg.args = [];
      if (!Array.isArray(msg.args) || !msg.args.every((a: unknown) => typeof a === "number" && Number.isFinite(a))) {
        return null;
      }
      return msg;
    case "stop":
      return typeof msg.token === "string" ? msg : null;
    case "pong":
      return typeof msg.id === "number" ? msg : null;
    default:
      return null;
  }
}
