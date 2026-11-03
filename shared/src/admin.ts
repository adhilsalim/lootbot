import type { MapFile } from "./map.js";
import type { Rules } from "./rules.js";
import type { MatchStage, RankedStats, TeamProfileView } from "./stage.js";

export type AgentStatus = "pending" | "accepted" | "declined" | "kicked";
export type TestStatus = "untested" | "running" | "green" | "amber" | "red";

export interface ConnectionTestResult {
  status: TestStatus;
  avgMs: number | null;
  maxMs: number | null;
  /** One line per check, e.g. "ping ok", "turn: no reply". */
  detail: string[];
}

export interface AgentInfo {
  id: string;
  team: string;
  status: AgentStatus;
  connected: boolean;
  /** Address the agent connected from. */
  remote: string;
  test: ConnectionTestResult;
  profile: TeamProfileView | null;
  /** Profile upload warnings shown in the approval preview. */
  profileNotes: string[];
}

export interface MapListEntry { file: string; name: string; width: number; height: number }

/** Everything the admin page shows. Sent whenever something changes. */
export interface AdminState {
  type: "state";
  stage: MatchStage;
  joinCode: string;
  /** e.g. ["ws://192.168.1.20:8080"]. */
  addresses: string[];
  agents: AgentInfo[];
  mapFile: string | null;
  map: MapFile | null;
  rules: Rules | null;
  maps: MapListEntry[];
  timeLeft: number | null;
  volume: number;
  stats: RankedStats[] | null;
  testRun: boolean;
}

export type AdminCommand =
  | { type: "accept"; id: string }
  | { type: "decline"; id: string; reason?: string }
  | { type: "kick"; id: string }
  | { type: "runTest"; id: string }
  | { type: "selectMap"; file: string }
  | { type: "setRules"; rules: Partial<Rules> }
  | { type: "toReady" }
  | { type: "toLobby" }
  | { type: "start"; override?: boolean }
  | { type: "skipIntro" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "abort" }
  | { type: "testRun"; file: string }
  | { type: "volume"; value: number }
  | { type: "showWinner" }
  | { type: "replay"; name: string }
  | { type: "replayControl"; action: "play" | "pause" | "seek" | "speed" | "stop"; value?: number };

export type ServerToAdmin =
  | AdminState
  | { type: "error"; message: string }
  | { type: "info"; message: string };
