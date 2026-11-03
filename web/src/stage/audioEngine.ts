import type { AudioEntry } from "@lootbot/shared";

const GAP_MS = 1000;

/**
 * Plays audio entries through the Web Audio API: each clip panned left/right by its
 * car's position, one master volume, and a 1 s gap between the two clips of an entry.
 */
export class AudioEngine {
  readonly ctx = new AudioContext();
  private master = this.ctx.createGain();
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private sources = new Set<AudioBufferSourceNode>();
  /** Bumped by `stop()` so a running entry knows to give up. */
  private generation = 0;
  private winSource: AudioBufferSourceNode | null = null;

  constructor() {
    this.master.connect(this.ctx.destination);
  }

  get enabled() {
    return this.ctx.state === "running";
  }

  /** Browsers only allow sound after a click: call this from the click handler. */
  enable() {
    return this.ctx.resume();
  }

  setVolume(v: number) {
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  /** Fetch and decode a clip once; later calls reuse it. */
  load(url: string) {
    let p = this.buffers.get(url);
    if (!p) {
      p = fetch(url)
        .then((r) => r.arrayBuffer())
        .then((b) => this.ctx.decodeAudioData(b))
        .catch(() => null);
      this.buffers.set(url, p);
    }
    return p;
  }

  /**
   * Play an entry's clips in order. `onClip` reports which clip is playing.
   * Resolves when done (or immediately when stopped).
   */
  async play(entry: AudioEntry, onClip: (index: number) => void) {
    const gen = this.generation;
    for (let i = 0; i < entry.clips.length; i++) {
      if (gen !== this.generation) return;
      if (i > 0) await this.wait(GAP_MS);
      if (gen !== this.generation) return;
      onClip(i);
      const c = entry.clips[i];
      const buf = await this.load(c.url);
      if (gen !== this.generation) return;
      if (!buf) continue;
      await this.playBuffer(buf, c.pan);
    }
  }

  private playBuffer(buf: AudioBuffer, pan: number) {
    return new Promise<void>((resolve) => {
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      const panner = new StereoPannerNode(this.ctx, { pan });
      src.connect(panner).connect(this.master);
      this.sources.add(src);
      src.onended = () => {
        this.sources.delete(src);
        resolve();
      };
      src.start();
    });
  }

  /** Waits in audio-clock time, so pausing the context also pauses the gap. */
  private wait(ms: number) {
    return new Promise<void>((resolve) => {
      const src = this.ctx.createBufferSource();
      src.buffer = this.ctx.createBuffer(1, Math.max(1, Math.round((this.ctx.sampleRate * ms) / 1000)), this.ctx.sampleRate);
      src.connect(this.master);
      this.sources.add(src);
      src.onended = () => {
        this.sources.delete(src);
        resolve();
      };
      src.start();
    });
  }

  pause(paused: boolean) {
    if (paused) void this.ctx.suspend();
    else void this.ctx.resume();
  }

  /** Stop everything now (queue cleared). */
  stop() {
    this.generation++;
    for (const s of this.sources) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        // already stopped
      }
    }
    this.sources.clear();
  }

  async playWin(url: string) {
    this.stopWin();
    const buf = await this.load(url);
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.master);
    src.start();
    this.winSource = src;
  }

  stopWin() {
    try {
      this.winSource?.stop();
    } catch {
      // already stopped
    }
    this.winSource = null;
  }
}
