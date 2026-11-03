import type { AudioEntry, TeamProfileView } from "@lootbot/shared";

interface Props {
  entry: AudioEntry | null;
  /** Index of the clip playing right now within the entry. */
  clipIndex: number;
  upNext: AudioEntry[];
  profiles: Map<string, TeamProfileView>;
}

function TeamIcon({ team, profiles, active }: { team: string; profiles: Map<string, TeamProfileView>; active?: boolean }) {
  const p = profiles.get(team);
  return (
    <span className={`np-team ${active ? "active" : ""}`} style={{ borderColor: p?.color }}>
      {p?.icon ? <img src={p.icon} alt="" /> : <span className="np-dot" style={{ background: p?.color }}>{team[0]}</span>}
      <b>{team}</b>
    </span>
  );
}

/** "Now playing" banner with a sound wave, plus the "Up next" strip. */
export function NowPlaying({ entry, clipIndex, upNext, profiles }: Props) {
  const playingTeam = entry?.clips[clipIndex]?.team;
  return (
    <div className="now-playing-bar">
      <div className={`now-playing ${entry ? "on" : ""} p${entry?.priority ?? 0}`}>
        {entry && (
          <>
            <span className="np-label">Now playing</span>
            <span className="np-teams">
              {entry.teams.map((t, i) => (
                <span key={t} className="np-pair">
                  {i > 0 && <span className="np-arrow">→</span>}
                  <TeamIcon team={t} profiles={profiles} active={t === playingTeam} />
                </span>
              ))}
            </span>
            <span className="np-text">{entry.label}</span>
            <span className="wave" aria-hidden>
              {Array.from({ length: 7 }, (_, i) => <i key={i} style={{ animationDelay: `${i * 0.11}s` }} />)}
            </span>
          </>
        )}
      </div>
      {upNext.length > 0 && (
        <div className="up-next">
          <span className="np-label">Up next</span>
          {upNext.map((e) => (
            <span key={e.id} className={`un-item p${e.priority}`} title={e.label}>
              {e.teams.map((t) => {
                const p = profiles.get(t);
                return p?.icon ? <img key={t} src={p.icon} alt="" /> : <span key={t} className="np-dot" style={{ background: p?.color }}>{t[0]}</span>;
              })}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
