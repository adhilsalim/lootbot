import { useState } from "react";
import type { AdminCommand, AdminState, AgentInfo } from "@lootbot/shared";
import { formatTime } from "../lib/socket";

interface Props {
  state: AdminState;
  send: (c: AdminCommand) => void;
  adminKey: string;
}

const STAGES = ["lobby", "ready", "intro", "running", "finished", "stats"] as const;

export function MatchTab({ state, send, adminKey }: Props) {
  const pending = state.agents.filter((a) => a.status === "pending");
  const accepted = state.agents.filter((a) => a.status === "accepted");
  const address = state.addresses[0];

  return (
    <div className="match-tab">
      <section className="card connect-card">
        <h2>Join</h2>
        <div className="connect">
          <img className="qr" src={`/api/admin/qr?key=${encodeURIComponent(adminKey)}&text=${encodeURIComponent(address)}`} alt="QR code" />
          <div>
            <div className="label">Server address</div>
            {state.addresses.map((a) => (
              <div key={a} className="big mono">{a}</div>
            ))}
            <div className="label">Join code</div>
            <div className="big mono accent">{state.joinCode}</div>
            <a href="/stage" target="_blank" rel="noreferrer">Open stage screen ↗</a>
          </div>
        </div>
      </section>

      <MatchControls state={state} send={send} />

      <section className="card">
        <h2>Pending requests {pending.length > 0 && <span className="badge">{pending.length}</span>}</h2>
        {pending.length === 0 && <p className="muted">No one is waiting.</p>}
        {pending.map((a) => (
          <PendingAgent key={a.id} agent={a} send={send} />
        ))}
      </section>

      <section className="card">
        <h2>Teams ({accepted.length})</h2>
        {accepted.length === 0 && <p className="muted">Accepted teams appear here.</p>}
        <table className="teams">
          <tbody>
            {accepted.map((a) => (
              <tr key={a.id}>
                <td>
                  <span className={`dot test-${a.test.status}`} title={a.test.status} />
                </td>
                <td>
                  <TeamBadge agent={a} />
                </td>
                <td className="muted">{a.connected ? a.remote : "offline"}</td>
                <td className="mono small">
                  {a.test.avgMs !== null && `${a.test.avgMs} ms avg / ${a.test.maxMs} ms worst`}
                  {a.test.detail.length > 0 && <div className="muted">{a.test.detail.join(" · ")}</div>}
                </td>
                <td className="actions">
                  <button disabled={!a.connected || a.test.status === "running" || !["lobby", "ready"].includes(state.stage)} onClick={() => send({ type: "runTest", id: a.id })}>
                    {a.test.status === "untested" ? "Test" : "Rerun test"}
                  </button>
                  <button className="danger" onClick={() => confirm(`Kick ${a.team}?`) && send({ type: "kick", id: a.id })}>
                    Kick
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function TeamBadge({ agent }: { agent: AgentInfo }) {
  const p = agent.profile;
  return (
    <span className="team-badge">
      {p?.icon ? <img src={p.icon} alt="" /> : <span className="swatch" style={{ background: p?.color }} />}
      <b>{agent.team}</b>
    </span>
  );
}

function PendingAgent({ agent, send }: { agent: AgentInfo; send: Props["send"] }) {
  const p = agent.profile;
  const photos = [p?.driver, ...(p?.passengers ?? [])].filter(Boolean) as string[];
  const clips = Object.entries(p?.clips ?? {});
  return (
    <div className="pending">
      <div className="pending-head">
        <TeamBadge agent={agent} />
        <span className="muted">from {agent.remote}</span>
        <span className="spacer" />
        <button className="primary" onClick={() => send({ type: "accept", id: agent.id })}>Accept</button>
        <button
          className="danger"
          onClick={() => {
            const reason = prompt(`Decline ${agent.team}? Optional reason:`, "Declined by the host.");
            if (reason !== null) send({ type: "decline", id: agent.id, reason });
          }}
        >
          Decline
        </button>
      </div>
      {photos.length > 0 && (
        <div className="photos">
          {photos.map((src) => (
            <img key={src} src={src} alt="" />
          ))}
        </div>
      )}
      {clips.length > 0 && (
        <div className="clips">
          {clips.map(([slot, url]) => (
            <button key={slot} onClick={() => new Audio(url).play()}>▶ {slot}</button>
          ))}
        </div>
      )}
      {agent.profileNotes.map((n) => (
        <div key={n} className="note">{n}</div>
      ))}
    </div>
  );
}

function MatchControls({ state, send }: { state: AdminState; send: Props["send"] }) {
  const [minutes, setMinutes] = useState<string>("");
  const stage = state.stage;
  const editable = stage === "lobby" || stage === "ready";
  const accepted = state.agents.filter((a) => a.status === "accepted");
  const allGreen = accepted.length > 0 && accepted.every((a) => a.test.status === "green" || a.test.status === "amber");
  const stepIdx = STAGES.indexOf(stage === "paused" ? "running" : stage);

  return (
    <section className="card controls">
      <h2>
        Match {state.testRun && <span className="badge">test run</span>}
      </h2>
      <ol className="stages">
        {STAGES.map((s, i) => (
          <li key={s} className={i === stepIdx ? "current" : i < stepIdx ? "done" : ""}>
            {s === "running" && stage === "paused" ? "paused" : s}
          </li>
        ))}
      </ol>

      <div className="row">
        <label>Map</label>
        <select disabled={!editable} value={state.mapFile ?? ""} onChange={(e) => send({ type: "selectMap", file: e.target.value })}>
          <option value="" disabled>Pick a map…</option>
          {state.maps.map((m) => (
            <option key={m.file} value={m.file}>{m.name} ({m.width}×{m.height})</option>
          ))}
        </select>
      </div>
      <div className="row">
        <label>Duration</label>
        <input
          type="number"
          min={1}
          max={60}
          disabled={!editable || !state.map}
          placeholder={state.rules ? String(state.rules.matchSeconds / 60) : "10"}
          value={minutes}
          onChange={(e) => setMinutes(e.target.value)}
          onBlur={() => {
            const m = Number(minutes);
            if (m > 0) send({ type: "setRules", rules: { matchSeconds: Math.round(m * 60) } });
            setMinutes("");
          }}
        />
        <span className="muted">min {state.rules && `(now ${formatTime(state.rules.matchSeconds)})`}</span>
      </div>

      <div className="timer-big">{state.timeLeft !== null ? formatTime(state.timeLeft) : state.rules ? formatTime(state.rules.matchSeconds) : "--:--"}</div>

      <div className="buttons">
        {stage === "lobby" && (
          <button disabled={!state.map} onClick={() => send({ type: "toReady" })}>Go to ready check</button>
        )}
        {stage === "ready" && (
          <>
            <button onClick={() => send({ type: "toLobby" })}>Back to lobby</button>
            <button className="primary" disabled={!allGreen} onClick={() => send({ type: "start" })}>Start</button>
            <button
              disabled={accepted.length === 0}
              onClick={() => confirm("Start even though not every team passed the test?") && send({ type: "start", override: true })}
            >
              Start (override)
            </button>
          </>
        )}
        {stage === "intro" && <button onClick={() => send({ type: "skipIntro" })}>Skip intro</button>}
        {stage === "running" && <button onClick={() => send({ type: "pause" })}>Pause</button>}
        {stage === "paused" && <button className="primary" onClick={() => send({ type: "resume" })}>Resume</button>}
        {(stage === "intro" || stage === "running" || stage === "paused") && (
          <button className="danger" onClick={() => confirm("Abort the match? There will be no result.") && send({ type: "abort" })}>
            Abort
          </button>
        )}
        {(stage === "finished" || stage === "stats") && (
          <button onClick={() => send({ type: "toLobby" })}>New match</button>
        )}
      </div>

      <div className="row">
        <label>Volume</label>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={state.volume}
          onChange={(e) => send({ type: "volume", value: Number(e.target.value) })}
        />
        <span className="muted">{Math.round(state.volume * 100)}%</span>
      </div>
    </section>
  );
}
