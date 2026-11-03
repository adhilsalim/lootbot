import type { TeamProfileView, WorldView } from "@lootbot/shared";

export function Scoreboard({ world, profiles }: { world: WorldView | null; profiles: Map<string, TeamProfileView> }) {
  const cars = [...(world?.cars ?? [])].sort((a, b) => b.gifts - a.gifts || a.team.localeCompare(b.team));
  return (
    <aside className="scoreboard">
      <h2>Scoreboard</h2>
      {cars.length === 0 && <p className="muted">No cars yet</p>}
      {cars.map((c, i) => {
        const p = profiles.get(c.team);
        return (
          <div key={c.id} className={`score-row ${c.alive ? "" : "dead"}`} style={{ borderColor: p?.color }}>
            <span className="rank">{i + 1}</span>
            {p?.icon ? <img className="icon" src={p.icon} alt="" /> : <span className="icon dot" style={{ background: p?.color }} />}
            <span className="name">
              {c.team}
              {!c.connected && <span className="muted"> (offline)</span>}
            </span>
            <span className="gifts">🎁 {c.gifts}</span>
            <div className="bars">
              <div className="life" style={{ width: `${(c.life / c.maxLife) * 100}%` }} />
            </div>
            <span className="ammo">• {c.ammo}</span>
          </div>
        );
      })}
    </aside>
  );
}
