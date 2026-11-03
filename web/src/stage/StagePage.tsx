import { useEffect, useMemo, useState } from "react";
import type { MapFile, MatchStage, RankedStats, Rules, ServerToStage, StageToServer, TeamProfileView, WorldView } from "@lootbot/shared";
import { formatTime, useSocket } from "../lib/socket";
import { MazeCanvas } from "./MazeCanvas";
import { Scoreboard } from "./Scoreboard";
import { StatsScreen } from "./StatsScreen";
import { WinnerScreen } from "./WinnerScreen";
import { IntroScreen } from "./IntroScreen";

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

  useEffect(() => {
    if (!stats) return setShowWinner(false);
    const t = setTimeout(() => setShowWinner(true), STATS_MS);
    return () => clearTimeout(t);
  }, [stats]);

  const { connected } = useSocket<ServerToStage, StageToServer>("/ws/stage", (msg) => {
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
    }
  });

  const profileMap = useMemo(() => new Map(profiles.map((p) => [p.team, p])), [profiles]);

  // Load every team's photos as soon as they are known, so nothing loads mid-match.
  useEffect(() => {
    for (const p of profiles) {
      for (const src of [p.icon, p.driver, ...p.passengers]) if (src) new Image().src = src;
    }
  }, [profiles]);
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

      <main className="stage-main">
        <div className="maze-box">
          {map ? (
            <MazeCanvas map={map} world={world} profiles={profileMap} tickMs={tickMs} />
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
