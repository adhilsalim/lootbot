import type { RankedStats, TeamProfileView } from "@lootbot/shared";

interface Props {
  stats: RankedStats[];
  profiles: Map<string, TeamProfileView>;
}

const COLUMNS: { label: string; get: (s: RankedStats) => string | number }[] = [
  { label: "Gifts", get: (s) => s.gifts },
  { label: "Deaths", get: (s) => s.deaths },
  { label: "Hits landed / taken", get: (s) => `${s.hitsLanded} / ${s.hitsTaken}` },
  { label: "Accuracy", get: (s) => (s.shotsFired ? `${Math.round(s.accuracy * 100)}%` : "—") },
  { label: "Kills", get: (s) => s.kills },
  { label: "Gifts lost", get: (s) => s.giftsLost },
  { label: "Pickups", get: (s) => s.pickups },
  { label: "Distance", get: (s) => Math.round(s.distance) },
];

/** End-of-match table, one row per team, sorted by rank. */
export function StatsScreen({ stats, profiles }: Props) {
  return (
    <div className="stats-screen">
      <h1>Results</h1>
      <table className="stats-table">
        <thead>
          <tr>
            <th>Rank</th>
            <th className="left">Team</th>
            {COLUMNS.map((c) => <th key={c.label}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {stats.map((s, i) => {
            const p = profiles.get(s.team);
            return (
              <tr key={s.team} style={{ animationDelay: `${(stats.length - i) * 0.4}s` }}>
                <td className="rank">{s.rank}</td>
                <td className="left team">
                  {p?.icon ? <img src={p.icon} alt="" /> : <span className="dot-lg" style={{ background: p?.color }} />}
                  {s.team}
                </td>
                {COLUMNS.map((c) => <td key={c.label}>{c.get(s)}</td>)}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
