import type { AudioClipRef, AudioEntry, ClipSlot, ServerToStage, TeamProfileView } from "@lootbot/shared";
import type { WorldEvent } from "./game/world.js";

/** Pause after each entry, and between the two clips of a two-clip entry. */
export const GAP_MS = 1000;
/** Entries waiting beyond this many get their oldest gift (priority 3) entries dropped. */
export const MAX_WAITING = 6;
/** Extra time before assuming the stage missed an `audioDone`. */
const SLACK_MS = 1500;

export interface AudioQueueOptions {
  send: (msg: ServerToStage) => void;
  /** Called when an entry starts playing (for the match log). */
  onPlay?: (entry: AudioEntry) => void;
}

/**
 * Decides what plays on the stage: one entry at a time, highest priority first
 * (oldest first among equals), 1 s gap between entries. Never cuts off a clip.
 */
export class AudioQueue {
  private waiting: AudioEntry[] = [];
  private playing: AudioEntry | null = null;
  private nextId = 1;
  private timer: NodeJS.Timeout | null = null;
  /** When the current timer fires and what it does, so pause can resume it. */
  private timerDue = 0;
  private timerFn: (() => void) | null = null;
  private remainingMs = 0;
  paused = false;

  constructor(private opts: AudioQueueOptions) {}

  get upNext() {
    return [...this.waiting].sort(byTurn).slice(0, 3);
  }

  get current() {
    return this.playing;
  }

  get waitingCount() {
    return this.waiting.length;
  }

  /** Queue an entry. Returns it, or null if it had no clips to play. */
  add(e: Omit<AudioEntry, "id">): AudioEntry | null {
    if (e.clips.length === 0) return null;
    const entry: AudioEntry = { ...e, id: this.nextId++ };
    this.waiting.push(entry);
    // Safety limit: drop the oldest gift entries; priority 1 and 2 are never dropped.
    while (this.waiting.length > MAX_WAITING) {
      const i = this.waiting.findIndex((w) => w.priority === 3);
      if (i === -1) break;
      this.waiting.splice(i, 1);
    }
    this.publishQueue();
    if (!this.playing && !this.timer && !this.paused) this.playNext();
    return this.waiting.includes(entry) || this.playing === entry ? entry : null;
  }

  /** The stage finished playing an entry. */
  done(id: number) {
    if (!this.playing || this.playing.id !== id) return;
    this.finishCurrent();
  }

  pause() {
    if (this.paused) return;
    this.paused = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.remainingMs = Math.max(0, this.timerDue - Date.now());
    }
    this.opts.send({ type: "audioPause", paused: true });
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.opts.send({ type: "audioPause", paused: false });
    if (this.timerFn) this.schedule(this.remainingMs, this.timerFn);
    else if (!this.playing) this.playNext();
  }

  /** Drop everything (match aborted or over). */
  clear() {
    this.waiting = [];
    this.playing = null;
    this.paused = false;
    this.cancelTimer();
    this.opts.send({ type: "audioClear" });
  }

  private playNext() {
    if (this.paused || this.playing) return;
    const next = this.upNext[0];
    if (!next) return;
    this.waiting.splice(this.waiting.indexOf(next), 1);
    this.playing = next;
    this.opts.onPlay?.(next);
    this.opts.send({ type: "audioPlay", entry: next });
    this.publishQueue();
    // Fallback in case no stage screen reports back.
    this.schedule(entryDurationMs(next) + SLACK_MS, () => this.finishCurrent());
  }

  private finishCurrent() {
    this.cancelTimer();
    this.playing = null;
    this.schedule(GAP_MS, () => {
      this.timerFn = null;
      this.playNext();
    });
  }

  private schedule(ms: number, fn: () => void) {
    this.cancelTimer();
    this.timerFn = fn;
    if (this.paused) {
      this.remainingMs = ms;
      return;
    }
    this.timerDue = Date.now() + ms;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.timerFn = null;
      fn();
    }, ms);
  }

  private cancelTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.timerFn = null;
  }

  private publishQueue() {
    this.opts.send({ type: "audioQueue", upNext: this.upNext });
  }
}

const byTurn = (a: AudioEntry, b: AudioEntry) => a.priority - b.priority || a.id - b.id;

export function entryDurationMs(e: AudioEntry) {
  return e.clips.reduce((ms, c) => ms + (c.duration ?? 3) * 1000, 0) + GAP_MS * (e.clips.length - 1);
}

/**
 * Turn a tick's world events into audio entries:
 * a kill (hit clip + death clip, priority 1), a hit (hit clip + got-hit clip, priority 2),
 * a gift pickup (gift clip, priority 3).
 */
export function entriesFromEvents(
  events: WorldEvent[],
  teamOf: (carId: string) => string | undefined,
  profileOf: (team: string) => TeamProfileView | undefined,
  mapWidth: number,
  tick: number,
): Omit<AudioEntry, "id">[] {
  const pan = (x: number) => (mapWidth <= 1 ? 0 : Math.max(-1, Math.min(1, (x / (mapWidth - 1)) * 2 - 1)));
  const clip = (team: string, slot: ClipSlot, x: number): AudioClipRef[] => {
    const p = profileOf(team);
    const url = p?.clips[slot];
    return url ? [{ team, slot, url, pan: Math.round(pan(x) * 100) / 100, duration: p?.clipDurations?.[slot] }] : [];
  };
  const out: Omit<AudioEntry, "id">[] = [];
  const killedByShot = new Set<string>();
  for (const e of events) {
    if (e.kind === "shotHit") {
      const a = teamOf(e.shooter);
      const b = teamOf(e.target);
      if (!a || !b) continue;
      if (e.killed) {
        killedByShot.add(e.target);
        out.push({ priority: 1, label: `${a} took down ${b}`, teams: [a, b], clips: [...clip(a, "hitEnemy", e.shooterX), ...clip(b, "death", e.targetX)], createdTick: tick });
      } else {
        out.push({ priority: 2, label: `${a} hit ${b}`, teams: [a, b], clips: [...clip(a, "hitEnemy", e.shooterX), ...clip(b, "gotHit", e.targetX)], createdTick: tick });
      }
    } else if (e.kind === "death" && !killedByShot.has(e.carId)) {
      const b = teamOf(e.carId);
      if (b) out.push({ priority: 1, label: `${b} is down`, teams: [b], clips: clip(b, "death", e.x), createdTick: tick });
    } else if (e.kind === "giftCollected") {
      const a = teamOf(e.carId);
      if (a) out.push({ priority: 3, label: `${a} collected a gift`, teams: [a], clips: clip(a, "gift", e.x), createdTick: tick });
    }
  }
  return out;
}
