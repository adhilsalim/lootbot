import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioEntry, ServerToStage, TeamProfileView } from "@lootbot/shared";
import { AudioQueue, entriesFromEvents } from "./audioQueue.js";

const clip = (team: string, duration = 1) => ({ team, slot: "gift" as const, url: `/${team}.mp3`, pan: 0, duration });
const entry = (priority: 1 | 2 | 3, label: string, clips = [clip(label)]): Omit<AudioEntry, "id"> => ({
  priority,
  label,
  teams: [label],
  clips,
  createdTick: 0,
});

function setup() {
  const sent: ServerToStage[] = [];
  const played: string[] = [];
  const q = new AudioQueue({ send: (m) => sent.push(m), onPlay: (e) => played.push(e.label) });
  return { q, sent, played };
}

describe("AudioQueue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("plays one entry at a time with a 1 s gap, highest priority first", () => {
    const { q, played } = setup();
    q.add(entry(3, "gift-a"));
    q.add(entry(3, "gift-b"));
    q.add(entry(2, "hit"));
    expect(played).toEqual(["gift-a"]); // started immediately
    q.done(q.current!.id);
    vi.advanceTimersByTime(999);
    expect(played).toEqual(["gift-a"]);
    vi.advanceTimersByTime(1);
    expect(played).toEqual(["gift-a", "hit"]); // priority 2 before the older gift
    q.done(q.current!.id);
    vi.advanceTimersByTime(1000);
    expect(played).toEqual(["gift-a", "hit", "gift-b"]);
  });

  it("a new priority 1 entry jumps ahead but never cuts off the playing clip", () => {
    const { q, played, sent } = setup();
    q.add(entry(3, "gift"));
    q.add(entry(2, "hit"));
    q.add(entry(1, "kill"));
    expect(q.current!.label).toBe("gift");
    expect(sent.filter((m) => m.type === "audioClear")).toHaveLength(0);
    q.done(q.current!.id);
    vi.advanceTimersByTime(1000);
    expect(played).toEqual(["gift", "kill"]);
  });

  it("drops the oldest gift entries when more than 6 wait; never priority 1 or 2", () => {
    const { q } = setup();
    q.add(entry(1, "playing"));
    for (let i = 0; i < 4; i++) q.add(entry(3, `gift${i}`));
    q.add(entry(2, "hit"));
    q.add(entry(1, "kill"));
    expect(q.waitingCount).toBe(6);
    q.add(entry(3, "gift-new"));
    expect(q.waitingCount).toBe(6);
    const labels = [];
    while (q.current) {
      q.done(q.current.id);
      vi.advanceTimersByTime(1000);
      if (q.current) labels.push(q.current.label);
    }
    expect(labels).toEqual(["kill", "hit", "gift1", "gift2", "gift3", "gift-new"]);

    // Only priority 1/2 waiting: nothing is dropped even past the limit.
    const { q: q2 } = setup();
    q2.add(entry(1, "playing"));
    for (let i = 0; i < 8; i++) q2.add(entry(2, `hit${i}`));
    expect(q2.waitingCount).toBe(8);
  });

  it("falls back to its own timer when the stage never reports back", () => {
    const { q, played } = setup();
    q.add(entry(1, "kill", [clip("A", 2), clip("B", 1)])); // 2 + 1 gap + 1 = 4 s
    q.add(entry(3, "gift"));
    vi.advanceTimersByTime(4000 + 1500 - 1);
    expect(played).toEqual(["kill"]);
    vi.advanceTimersByTime(1 + 1000);
    expect(played).toEqual(["kill", "gift"]);
  });

  it("pause holds the queue; resume continues where it left off", () => {
    const { q, played, sent } = setup();
    q.add(entry(3, "a"));
    q.add(entry(3, "b"));
    q.done(q.current!.id); // gap timer running
    vi.advanceTimersByTime(500);
    q.pause();
    expect(sent.at(-1)).toEqual({ type: "audioPause", paused: true });
    vi.advanceTimersByTime(10000);
    expect(played).toEqual(["a"]);
    q.add(entry(1, "kill")); // queued while paused, does not start
    expect(played).toEqual(["a"]);
    q.resume();
    vi.advanceTimersByTime(499);
    expect(played).toEqual(["a"]);
    vi.advanceTimersByTime(1);
    expect(played).toEqual(["a", "kill"]);
  });

  it("clear drops everything", () => {
    const { q, sent } = setup();
    q.add(entry(3, "a"));
    q.add(entry(3, "b"));
    q.clear();
    expect(q.current).toBeNull();
    expect(q.waitingCount).toBe(0);
    expect(sent.at(-1)).toEqual({ type: "audioClear" });
    vi.advanceTimersByTime(10000);
    expect(q.current).toBeNull();
  });

  it("ignores entries with no clips", () => {
    const { q } = setup();
    expect(q.add(entry(3, "silent", []))).toBeNull();
    expect(q.current).toBeNull();
  });
});

describe("entriesFromEvents", () => {
  const prof = (team: string, clips: TeamProfileView["clips"]): TeamProfileView => ({
    team, icon: null, driver: null, passengers: [], clips, color: "#fff", clipDurations: { hitEnemy: 2 },
  });
  const profiles: Record<string, TeamProfileView> = {
    A: prof("A", { hitEnemy: "/a-hit.mp3", gift: "/a-gift.mp3" }),
    B: prof("B", { death: "/b-death.mp3" }), // no gotHit clip
  };
  const teamOf = (id: string) => ({ a: "A", b: "B" })[id];

  it("builds kill, hit and gift entries with panning by x position", () => {
    const out = entriesFromEvents(
      [
        { kind: "shotHit", shooter: "a", target: "b", killed: false, shooterX: 0, targetX: 10 },
        { kind: "shotHit", shooter: "a", target: "b", killed: true, shooterX: 0, targetX: 5 },
        { kind: "death", carId: "b", killer: "a", x: 5 },
        { kind: "giftCollected", carId: "a", x: 10 },
        { kind: "giftCollected", carId: "b", x: 3 },
      ],
      teamOf,
      (t) => profiles[t],
      11,
      42,
    );
    expect(out.map((e) => [e.priority, e.label, e.clips.map((c) => [c.url, c.pan])])).toEqual([
      [2, "A hit B", [["/a-hit.mp3", -1]]], // B's got-hit half is skipped
      [1, "A took down B", [["/a-hit.mp3", -1], ["/b-death.mp3", 0]]],
      [3, "A collected a gift", [["/a-gift.mp3", 1]]],
      [3, "B collected a gift", []],
    ]);
    expect(out[0].clips[0].duration).toBe(2);
    expect(out[0].createdTick).toBe(42);
  });
});
