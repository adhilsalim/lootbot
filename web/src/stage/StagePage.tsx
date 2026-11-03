import { useMemo, useState } from "react";
import type { MapFile, MatchStage, RankedStats, Rules, ServerToStage, StageToServer, TeamProfileView, WorldView } from "@lootbot/shared";
import { formatTime, useSocket } from "../lib/socket";
import { MazeCanvas } from "./MazeCanvas";
import { Scoreboard } from "./Scoreboard";

export function StagePage() {
  const [stage, setStage] = useState<MatchStage>("lobby");
  const [map, setMap] = useState<MapFile | null>(null);
  const [rules, setRules] = useState<Rules | null>(null);
  const [profiles, setProfiles] = useState<TeamProfileView[]>([]);
  const [world, setWorld] = useState<WorldView | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [stats, setStats] = useState<{ stats: RankedStats[]; winner: string | null } | null>(null);

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
      case "countdown":
        setCountdown(msg.value);
        if (msg.value === 0) setTimeout(() => setCountdown(null), 900);
        break;
      case "stats":
        setStats({ stats: msg.stats, winner: msg.winner });
        break;
    }
  });

  const profileMap = useMemo(() => new Map(profiles.map((p) => [p.team, p])), [profiles]);
  const tickMs = 1000 / (rules?.tickRate ?? 10);

  return (
    <div className="stage">
      <header className="stage-top">
        <div className="stage-title">{map?.name ?? "Lootbot"}</div>
        <div className={`stage-timer ${world && world.timeLeft <= 30 ? "low" : ""}`}>
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
          {countdown !== null && (
            <div className="overlay countdown" key={countdown}>{countdown > 0 ? countdown : "GO!"}</div>
          )}
          {stage === "finished" && <div className="overlay banner">Time!</div>}
        </div>
        <Scoreboard world={world} profiles={profileMap} />
      </main>

      {stage === "stats" && stats && (
        <div className="overlay full">
          <h1>Results</h1>
          <p>Winner: {stats.winner ?? "—"}</p>
        </div>
      )}
    </div>
  );
}
