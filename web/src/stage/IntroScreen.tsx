import { useEffect, useState } from "react";
import type { TeamProfileView } from "@lootbot/shared";

interface Props {
  teams: string[];
  perTeamMs: number;
  startedAt: number;
  profiles: Map<string, TeamProfileView>;
}

/** Shows each team in turn during the intro: name, icon, driver and passengers. */
export function IntroScreen({ teams, perTeamMs, startedAt, profiles }: Props) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, []);
  const idx = Math.min(teams.length - 1, Math.floor((now - startedAt) / perTeamMs));
  const team = teams[idx];
  const p = profiles.get(team);
  if (!team) return null;
  const color = p?.color ?? "#ffcc33";

  return (
    <div className="intro" key={team} style={{ ["--team" as string]: color }}>
      <div className="intro-count">
        Team {idx + 1} of {teams.length}
      </div>
      <div className="intro-name">
        {p?.icon ? <img className="intro-icon" src={p.icon} alt="" /> : <span className="intro-icon dot-lg" style={{ background: color }} />}
        {team}
      </div>
      <div className="crew">
        {p?.driver && (
          <figure className="driver">
            <img src={p.driver} alt="" />
            <figcaption>Driver</figcaption>
          </figure>
        )}
        {p?.passengers.map((src, i) => (
          <figure key={src} style={{ animationDelay: `${0.2 + i * 0.15}s` }}>
            <img src={src} alt="" />
            <figcaption>Passenger {i + 1}</figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}
