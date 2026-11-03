import { useState } from "react";
import { useAdmin, useAdminKey } from "./useAdmin";
import { MatchTab } from "./MatchTab";
import { MapBuilder } from "./MapBuilder";

type Tab = "match" | "maps" | "replays";

export function AdminPage() {
  const [key, setKey] = useAdminKey();
  const admin = useAdmin(key);
  const [tab, setTab] = useState<Tab>("match");

  if (!key) return <KeyPrompt onKey={setKey} />;

  return (
    <div className="admin">
      <header className="admin-top">
        <h1>Lootbot admin</h1>
        <nav className="tabs">
          {(["match", "maps", "replays"] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
              {{ match: "Match", maps: "Map builder", replays: "Replays" }[t]}
            </button>
          ))}
        </nav>
        <span className={`conn ${admin.connected ? "ok" : "bad"}`}>{admin.connected ? "connected" : "disconnected"}</span>
        <button onClick={() => setKey(null)}>Change key</button>
      </header>

      {!admin.state ? (
        <p className="muted">{admin.connected ? "Loading…" : "Connecting… (check the admin key if this persists)"}</p>
      ) : tab === "match" ? (
        <MatchTab state={admin.state} send={admin.send} adminKey={key} />
      ) : tab === "maps" ? (
        <MapBuilder adminKey={key} state={admin.state} send={admin.send} toast={admin.toast} />
      ) : (
        <p className="muted">Coming soon.</p>
      )}

      <div className="toasts">
        {admin.toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>
        ))}
      </div>
    </div>
  );
}

function KeyPrompt({ onKey }: { onKey: (k: string) => void }) {
  const [v, setV] = useState("");
  return (
    <div className="admin key-prompt">
      <h1>Lootbot admin</h1>
      <p>Enter the admin key printed in the server terminal.</p>
      <form onSubmit={(e) => (e.preventDefault(), v.trim() && onKey(v.trim()))}>
        <input autoFocus value={v} onChange={(e) => setV(e.target.value)} placeholder="admin key" />
        <button className="primary">Open</button>
      </form>
    </div>
  );
}
