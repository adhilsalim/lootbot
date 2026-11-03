import { useEffect, useState } from "react";
import type { AdminCommand, AdminState, MatchSummary } from "@lootbot/shared";
import { formatTime } from "../lib/socket";
import { adminFetch } from "./useAdmin";

interface Props {
  adminKey: string;
  state: AdminState;
  send: (c: AdminCommand) => void;
  toast: (kind: "error" | "info", text: string) => void;
}

export function ReplaysTab({ adminKey, state, send, toast }: Props) {
  const [matches, setMatches] = useState<MatchSummary[]>([]);
  const [seekTo, setSeekTo] = useState<number | null>(null);
  const r = state.replay;
  const between = ["lobby", "ready", "stats"].includes(state.stage);

  useEffect(() => {
    adminFetch(adminKey, "/api/admin/matches").then(setMatches).catch((e) => toast("error", e.message));
  }, [adminKey, state.stage]);

  const rate = state.rules?.tickRate ?? 10;
  const secs = (ticks: number) => formatTime(ticks / rate);

  return (
    <div className="replays">
      {r && (
        <section className="card replay-controls">
          <h2>Now replaying <span className="muted">{r.name}</span></h2>
          <div className="row">
            <button className="primary" onClick={() => send({ type: "replayControl", action: r.playing ? "pause" : "play" })}>
              {r.playing ? "Pause" : "Play"}
            </button>
            {[1, 2].map((s) => (
              <button key={s} className={r.speed === s ? "active-speed" : ""} onClick={() => send({ type: "replayControl", action: "speed", value: s })}>
                {s}×
              </button>
            ))}
            <span className="mono">{secs(seekTo ?? r.tick)} / {secs(r.totalTicks)}</span>
            <span className="spacer" />
            <button className="danger" onClick={() => send({ type: "replayControl", action: "stop" })}>Stop replay</button>
          </div>
          <input
            className="timeline"
            type="range"
            min={0}
            max={r.totalTicks}
            value={seekTo ?? r.tick}
            onChange={(e) => setSeekTo(Number(e.target.value))}
            onPointerUp={() => {
              if (seekTo !== null) send({ type: "replayControl", action: "seek", value: seekTo });
              setSeekTo(null);
            }}
          />
        </section>
      )}

      <section className="card">
        <h2>Saved matches</h2>
        {!between && <p className="note">Replays can be played between matches.</p>}
        {matches.length === 0 && <p className="muted">No saved matches yet.</p>}
        <table className="teams">
          <tbody>
            {matches.map((m) => (
              <tr key={m.name}>
                <td>{new Date(m.startedAt).toLocaleString()}</td>
                <td><b>{m.map}</b></td>
                <td>{m.teams.join(", ")}</td>
                <td>{m.winner ? `Winner: ${m.winner}` : <span className="muted">{m.endReason ?? "unfinished"}</span>}</td>
                <td className="muted">{m.totalTicks !== null ? secs(m.totalTicks) : ""}</td>
                <td className="actions">
                  {m.winner !== null && (
                    <a className="button" href={`/api/admin/stats.csv?key=${encodeURIComponent(adminKey)}&match=${encodeURIComponent(m.name)}`} download>CSV</a>
                  )}
                  <button disabled={!between || m.totalTicks === null} onClick={() => send({ type: "replay", name: m.name })}>Replay</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
