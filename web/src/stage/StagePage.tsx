import { useEffect, useMemo, useRef, useState } from "react";
import type { AudioEntry, MapFile, MatchStage, RankedStats, Rules, ServerToStage, StageToServer, TeamProfileView, WorldView } from "@lootbot/shared";
import { formatTime, useSocket } from "../lib/socket";
import { MazeCanvas } from "./MazeCanvas";
import { Scoreboard } from "./Scoreboard";
import { StatsScreen } from "./StatsScreen";
import { WinnerScreen } from "./WinnerScreen";
import { IntroScreen } from "./IntroScreen";
import { NowPlaying } from "./NowPlaying";
import { AudioEngine } from "./audioEngine";

/** How long the stats table shows before the winner screen, unless the host skips ahead. */
const STATS_MS = 12000;

export function StagePage() {
  const [stage, setStage] = useState<MatchStage>("lobby");
  const [map, setMap] = useState<MapFile | null>(null);
  const [rules, setRules] = useState<Rules | null>(null);
  const [profiles, setProfiles] = useState<TeamProfileView[]>([]);
  const [world, setWorld] = useState<WorldView | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [stats, setStats] = useState<{ stats: RankedStats[]; winner: string | null } | null>(null);
  const [showWinner, setShowWinner] = useState(false);
  const [intro, setIntro] = useState<{ teams: string[]; perTeamMs: number; startedAt: number } | null>(null);
  const [nowPlaying, setNowPlaying] = useState<AudioEntry | null>(null);
  const [clipIndex, setClipIndex] = useState(0);
  const [upNext, setUpNext] = useState<AudioEntry[]>([]);
  const [soundOn, setSoundOn] = useState(false);
  const engine = useMemo(() => new AudioEngine(), []);
  const playingId = useRef<number | null>(null);

  useEffect(() => {
    if (!stats) return setShowWinner(false);
    const t = setTimeout(() => setShowWinner(true), STATS_MS);
    return () => clearTimeout(t);
  }, [stats]);

  const play = (entry: AudioEntry) => {
    engine.stop();
    playingId.current = entry.id;
    setNowPlaying(entry);
    setClipIndex(0);
    const finished = () => {
      if (playingId.current !== entry.id) return;
      playingId.current = null;
      setNowPlaying(null);
      send({ type: "audioDone", id: entry.id });
    };
    if (engine.enabled) {
      engine.play(entry, setClipIndex).then(finished);
    } else {
      // No sound yet: still show the banner for about as long as the clips would play.
      const ms = entry.clips.reduce((t, c) => t + (c.duration ?? 3) * 1000, 0) + 1000 * (entry.clips.length - 1);
      setTimeout(finished, ms);
    }
  };

  const { connected, send } = useSocket<ServerToStage, StageToServer>("/ws/stage", (msg) => {
    switch (msg.type) {
      case "hello":
        setStage(msg.stage);
        setMap(msg.map);
        setRules(msg.rules);
        setProfiles(msg.profiles);
        break;
      case "stage":
        setStage(msg.stage);
        if (msg.stage === "lobby") {
          setWorld(null);
          setStats(null);
        }
        if (msg.stage === "intro") setStats(null);
        break;
      case "map":
        setMap(msg.map);
        setRules(msg.rules);
        break;
      case "profiles":
        setProfiles(msg.profiles);
        break;
      case "world":
        setWorld(msg.world);
        break;
      case "intro":
        setIntro({ teams: msg.teams, perTeamMs: msg.perTeamMs, startedAt: Date.now() - (msg.elapsedMs ?? 0) });
        break;
      case "countdown":
        setCountdown(msg.value);
        if (msg.value === 0) setTimeout(() => setCountdown(null), 900);
        break;
      case "stats":
        setStats({ stats: msg.stats, winner: msg.winner });
        break;
      case "showWinner":
        setShowWinner(true);
        break;
      case "audioPlay":
        play(msg.entry);
        break;
      case "audioQueue":
        setUpNext(msg.upNext);
        break;
      case "audioPause":
        engine.pause(msg.paused);
        break;
      case "audioClear":
        engine.stop();
        playingId.current = null;
        setNowPlaying(null);
        setUpNext([]);
        break;
      case "volume":
        engine.setVolume(msg.value);
        break;
    }
  });

  const profileMap = useMemo(() => new Map(profiles.map((p) => [p.team, p])), [profiles]);

  // Load every team's photos as soon as they are known, so nothing loads mid-match.
  useEffect(() => {
    for (const p of profiles) {
      for (const src of [p.icon, p.driver, ...p.passengers]) if (src) new Image().src = src;
      for (const url of Object.values(p.clips)) if (url) void engine.load(url);
    }
  }, [profiles, engine]);

  // The winner's win clip plays on the winner screen only.
  const winner = stats?.stats[0]?.team;
  const winClip = winner ? profileMap.get(winner)?.clips.win : undefined;
  useEffect(() => {
    if (stage === "stats" && showWinner && winClip && soundOn) void engine.playWin(winClip);
    return () => engine.stopWin();
  }, [stage, showWinner, winClip, soundOn, engine]);

  const glowTeam = nowPlaying?.clips[clipIndex]?.team ?? null;
  const tickMs = 1000 / (rules?.tickRate ?? 10);

  return (
    <div className="stage">
      <header className="stage-top">
        <div className="stage-title">{map?.name ?? "Lootbot"}</div>
        <div className={`stage-timer ${world && world.timeLeft <= 30 && (stage === "running" || stage === "paused") ? "low" : ""}`}>
          {world ? formatTime(world.timeLeft) : rules ? formatTime(rules.matchSeconds) : "--:--"}
        </div>
        <div className="stage-gifts">
          🎁 {world ? `${world.giftsLeft} / ${world.totalGifts}` : map ? map.gifts.length : "-"}
          {!connected && <span className="offline"> · reconnecting…</span>}
        </div>
      </header>

      <NowPlaying entry={nowPlaying} clipIndex={clipIndex} upNext={upNext} profiles={profileMap} />

      <main className="stage-main">
        <div className="maze-box">
          {map ? (
            <MazeCanvas map={map} world={world} profiles={profileMap} tickMs={tickMs} glowTeam={glowTeam} />
          ) : (
            <div className="stage-waiting">Waiting for the host to pick a map…</div>
          )}
          {stage === "paused" && <div className="overlay banner">Paused</div>}
          {stage === "intro" && intro && countdown === null && (
            <div className="overlay intro-overlay">
              <IntroScreen {...intro} profiles={profileMap} />
            </div>
          )}
          {countdown !== null && (
            <div className="overlay countdown" key={countdown}>{countdown > 0 ? countdown : "GO!"}</div>
          )}
          {stage === "finished" && <div className="overlay banner">Time!</div>}
        </div>
        <Scoreboard world={world} profiles={profileMap} />
      </main>

      {!soundOn && (
        <button className="enable-sound" onClick={() => engine.enable().then(() => setSoundOn(engine.enabled))}>
          🔊 Enable sound
        </button>
      )}

      {stage === "stats" && stats && (
        <div className="overlay full">
          {showWinner ? (
            <WinnerScreen winner={stats.stats[0]} profile={profileMap.get(stats.stats[0]?.team)} />
          ) : (
            <StatsScreen stats={stats.stats} profiles={profileMap} />
          )}
        </div>
      )}
    </div>
  );
}
