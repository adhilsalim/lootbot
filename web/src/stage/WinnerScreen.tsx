import type { RankedStats, TeamProfileView } from "@lootbot/shared";

interface Props {
  winner: RankedStats | undefined;
  profile: TeamProfileView | undefined;
}

/** The winning team's name, icon, driver and passenger photos. */
export function WinnerScreen({ winner, profile }: Props) {
  if (!winner) return <div className="winner-screen"><h1>No winner</h1></div>;
  const color = profile?.color ?? "#ffcc33";
  return (
    <div className="winner-screen" style={{ ["--team" as string]: color }}>
      <div className="confetti" aria-hidden>
        {Array.from({ length: 60 }, (_, i) => (
          <i key={i} style={{ left: `${(i * 37) % 100}%`, animationDelay: `${(i % 12) * 0.35}s`, background: i % 3 ? color : "#ffcc33" }} />
        ))}
      </div>
      <div className="winner-label">Winner</div>
      <div className="winner-name">
        {profile?.icon ? <img className="winner-icon" src={profile.icon} alt="" /> : <span className="winner-icon dot-lg" style={{ background: color }} />}
        {winner.team}
      </div>
      <div className="winner-gifts">{winner.gifts} {winner.gifts === 1 ? "gift" : "gifts"}</div>
      {(profile?.driver || (profile?.passengers.length ?? 0) > 0) && (
        <div className="crew">
          {profile?.driver && (
            <figure className="driver">
              <img src={profile.driver} alt="" />
              <figcaption>Driver</figcaption>
            </figure>
          )}
          {profile?.passengers.map((src, i) => (
            <figure key={src}>
              <img src={src} alt="" />
              <figcaption>Passenger {i + 1}</figcaption>
            </figure>
          ))}
        </div>
      )}
    </div>
  );
}
