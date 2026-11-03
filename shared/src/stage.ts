import type { MapFile } from "./map.js";
import type { Rules } from "./rules.js";

/** The six match stages, in order. `paused` is a sub-state of running. */
export type MatchStage = "lobby" | "ready" | "intro" | "running" | "paused" | "finished" | "stats";

export interface CarView {
  id: string;
  team: string;
  x: number;
  y: number;
  heading: number;
  life: number;
  maxLife: number;
  ammo: number;
  gifts: number;
  alive: boolean;
  protected: boolean;
  connected: boolean;
}

export interface ItemView {
  type: "gift" | "ammo" | "energy";
  x: number;
  y: number;
  id?: string;
}

export interface ShotView { from: { x: number; y: number }; to: { x: number; y: number }; hit: boolean }

/** Everything the stage screen needs to draw one tick. */
export interface WorldView {
  tick: number;
  timeLeft: number;
  cars: CarView[];
  items: ItemView[];
  shots: ShotView[];
  totalGifts: number;
  giftsLeft: number;
}

export interface TeamStats {
  team: string;
  gifts: number;
  deaths: number;
  hitsLanded: number;
  hitsTaken: number;
  shotsFired: number;
  kills: number;
  giftsLost: number;
  pickups: number;
  distance: number;
  lifeLeft: number;
}

export interface RankedStats extends TeamStats { rank: number; accuracy: number }

export interface TeamProfileView {
  team: string;
  /** URLs served by the game server; missing entries are null. */
  icon: string | null;
  driver: string | null;
  passengers: string[];
  clips: Partial<Record<ClipSlot, string>>;
  color: string;
}

export type ClipSlot = "gift" | "hitEnemy" | "gotHit" | "death" | "win";
export const CLIP_SLOTS: readonly ClipSlot[] = ["gift", "hitEnemy", "gotHit", "death", "win"];

export interface AudioClipRef {
  team: string;
  slot: ClipSlot;
  url: string;
  /** -1 (left) … 1 (right), from the car's x position when the entry was created. */
  pan: number;
}

export interface AudioEntry {
  id: number;
  priority: 1 | 2 | 3;
  /** e.g. "Falcon hit Eagle". */
  label: string;
  teams: string[];
  clips: AudioClipRef[];
  createdTick: number;
}

/** Messages the server sends to the stage screen (`/stage` socket). */
export type ServerToStage =
  | { type: "hello"; stage: MatchStage; map: MapFile | null; rules: Rules | null; profiles: TeamProfileView[] }
  | { type: "stage"; stage: MatchStage }
  | { type: "map"; map: MapFile | null; rules: Rules | null }
  | { type: "profiles"; profiles: TeamProfileView[] }
  | { type: "world"; world: WorldView }
  | { type: "countdown"; value: number }
  | { type: "stats"; stats: RankedStats[]; winner: string | null }
  | { type: "showWinner" }
  | { type: "audioPlay"; entry: AudioEntry }
  | { type: "audioQueue"; upNext: AudioEntry[] }
  | { type: "audioPause"; paused: boolean }
  | { type: "audioClear" }
  | { type: "volume"; value: number }
  | { type: "replay"; active: boolean; name?: string; totalTicks?: number; tick?: number; speed?: number; playing?: boolean };

export type StageToServer = { type: "audioDone"; id: number };
