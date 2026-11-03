import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_RULES,
  blankMap,
  isBorder,
  validateMap,
  type AdminCommand,
  type AdminState,
  type CellKind,
  type MapFile,
  type Rules,
  type ValidationResult,
} from "@lootbot/shared";
import { adminFetch } from "./useAdmin";

interface Grid {
  width: number;
  height: number;
  cells: CellKind[];
  /** Keeps gift ids stable across edits, keyed by cell index. */
  giftIds: Map<number, string>;
}

function gridFromMap(m: MapFile): Grid {
  const cells: CellKind[] = Array(m.width * m.height).fill("floor");
  const giftIds = new Map<number, string>();
  const at = (x: number, y: number) => y * m.width + x;
  m.walls.forEach(([x, y]) => (cells[at(x, y)] = "wall"));
  m.ammo.forEach(([x, y]) => (cells[at(x, y)] = "ammo"));
  m.energy.forEach(([x, y]) => (cells[at(x, y)] = "energy"));
  m.spawns.forEach(([x, y]) => (cells[at(x, y)] = "spawn"));
  m.gifts.forEach((g) => {
    cells[at(g.home[0], g.home[1])] = "gift";
    giftIds.set(at(g.home[0], g.home[1]), g.id);
  });
  return { width: m.width, height: m.height, cells, giftIds };
}

function mapFromGrid(name: string, g: Grid, rules: Partial<Rules>): MapFile {
  const m: MapFile = { name, width: g.width, height: g.height, walls: [], gifts: [], ammo: [], energy: [], spawns: [], rules };
  const used = new Set(g.giftIds.values());
  let n = 1;
  g.cells.forEach((k, i) => {
    const x = i % g.width;
    const y = Math.floor(i / g.width);
    if (isBorder(g, x, y)) return;
    if (k === "wall") m.walls.push([x, y]);
    if (k === "ammo") m.ammo.push([x, y]);
    if (k === "energy") m.energy.push([x, y]);
    if (k === "spawn") m.spawns.push([x, y]);
    if (k === "gift") {
      let id = g.giftIds.get(i);
      if (!id) {
        while (used.has(`g${n}`)) n++;
        id = `g${n}`;
        used.add(id);
        g.giftIds.set(i, id);
      }
      m.gifts.push({ id, home: [x, y] });
    }
  });
  return m;
}

function resizeGrid(g: Grid, width: number, height: number): Grid {
  const cells: CellKind[] = Array(width * height).fill("floor");
  const giftIds = new Map<number, string>();
  for (let y = 1; y < Math.min(g.height, height) - 1; y++) {
    for (let x = 1; x < Math.min(g.width, width) - 1; x++) {
      cells[y * width + x] = g.cells[y * g.width + x];
      const id = g.giftIds.get(y * g.width + x);
      if (id) giftIds.set(y * width + x, id);
    }
  }
  return { width, height, cells, giftIds };
}

const BRUSHES: { kind: CellKind; label: string; color: string }[] = [
  { kind: "wall", label: "Wall", color: "#5b6478" },
  { kind: "floor", label: "Floor (eraser)", color: "#1b1f2a" },
  { kind: "gift", label: "Gift", color: "#ffcc33" },
  { kind: "ammo", label: "Ammo", color: "#c9a227" },
  { kind: "energy", label: "Energy drink", color: "#2ecc71" },
  { kind: "spawn", label: "Spawn point", color: "#6aa0ff" },
];
const COLOR = Object.fromEntries(BRUSHES.map((b) => [b.kind, b.color])) as Record<CellKind, string>;

type RuleSpec = { key: keyof Rules; label: string; kind: "bool" | "num" | "never"; unit?: string; step?: number };
const RULES: RuleSpec[] = [
  { key: "revealItems", label: "Reveal item locations", kind: "bool" },
  { key: "showScoreboard", label: "Show scoreboard to agents", kind: "bool" },
  { key: "sightRange", label: "Line of sight range", kind: "num", unit: "cells" },
  { key: "startLife", label: "Starting life", kind: "num" },
  { key: "maxLife", label: "Max life", kind: "num" },
  { key: "damage", label: "Damage per hit", kind: "num" },
  { key: "startAmmo", label: "Starting ammo", kind: "num" },
  { key: "maxAmmo", label: "Max ammo", kind: "num" },
  { key: "ammoPerPickup", label: "Ammo per pickup", kind: "num" },
  { key: "fireCooldownSec", label: "Fire cooldown", kind: "num", unit: "s", step: 0.1 },
  { key: "energyPerDrink", label: "Energy per drink", kind: "num" },
  { key: "ammoRespawnSec", label: "Ammo respawn delay", kind: "never", unit: "s" },
  { key: "energyRespawnSec", label: "Energy respawn delay", kind: "never", unit: "s" },
  { key: "respawnDelaySec", label: "Respawn delay", kind: "num", unit: "s", step: 0.5 },
  { key: "protectionSec", label: "Respawn protection", kind: "num", unit: "s", step: 0.5 },
  { key: "giftsLostOnDeath", label: "Gifts lost on death", kind: "num" },
  { key: "matchSeconds", label: "Match length", kind: "num", unit: "s" },
  { key: "tickRate", label: "Tick rate", kind: "num", unit: "/s" },
];

interface Props {
  adminKey: string;
  state: AdminState;
  send: (c: AdminCommand) => void;
  toast: (kind: "error" | "info", text: string) => void;
}

export function MapBuilder({ adminKey, state, send, toast }: Props) {
  const [file, setFile] = useState<string | null>(null);
  const [name, setName] = useState("New map");
  const [grid, setGrid] = useState<Grid>(() => gridFromMap(blankMap("New map")));
  const [rules, setRules] = useState<Partial<Rules>>({});
  const [brush, setBrush] = useState<CellKind>("wall");
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [dirty, setDirty] = useState(false);
  const expectedTeams = Math.max(2, state.agents.filter((a) => a.status === "accepted").length);
  const busyMatch = !(state.stage === "lobby" || state.stage === "ready");

  const edit = (g: Grid) => {
    setGrid(g);
    setDirty(true);
    setValidation(null);
  };

  const load = async (f: string) => {
    if (dirty && !confirm("Discard unsaved changes?")) return;
    try {
      const m: MapFile = await adminFetch(adminKey, `/api/admin/maps/${encodeURIComponent(f)}`);
      setFile(f);
      setName(m.name);
      setGrid(gridFromMap(m));
      setRules(m.rules ?? {});
      setDirty(false);
      setValidation(null);
    } catch (e) {
      toast("error", (e as Error).message);
    }
  };

  const newMap = () => {
    if (dirty && !confirm("Discard unsaved changes?")) return;
    const size = prompt("Grid size (width × height)", "30x20");
    if (!size) return;
    const [w, h] = size.split(/[x×, ]+/).map(Number);
    if (!(w >= 5 && h >= 5 && w <= 200 && h <= 200)) return toast("error", "Size must be between 5 and 200.");
    setFile(null);
    setName("New map");
    setGrid(gridFromMap(blankMap("New map", w, h)));
    setRules({});
    setDirty(true);
    setValidation(null);
  };

  const current = () => mapFromGrid(name.trim(), grid, rules);

  const validate = () => {
    const v = validateMap(current(), expectedTeams);
    setValidation(v);
    return v;
  };

  const save = async (): Promise<string | null> => {
    const v = validate();
    if (!v.ok) {
      toast("error", "Fix the problems before saving.");
      return null;
    }
    try {
      const r = await adminFetch(adminKey, "/api/admin/maps", {
        method: "POST",
        body: JSON.stringify({ map: current(), file: file ?? undefined }),
      });
      setFile(r.file);
      setDirty(false);
      toast("info", `Saved ${r.file}`);
      return r.file;
    } catch (e) {
      toast("error", (e as Error).message);
      return null;
    }
  };

  const mapAction = async (path: string, method = "POST", body?: unknown) => {
    try {
      const r = await adminFetch(adminKey, path, { method, body: body ? JSON.stringify(body) : undefined });
      return r;
    } catch (e) {
      toast("error", (e as Error).message);
      return null;
    }
  };

  const counts = grid.cells.reduce<Record<string, number>>((c, k) => ((c[k] = (c[k] ?? 0) + 1), c), {});

  return (
    <div className="builder">
      <aside className="card map-list">
        <h2>Maps</h2>
        <button className="primary wide" onClick={newMap}>+ New map</button>
        <ul>
          {state.maps.map((m) => (
            <li key={m.file} className={m.file === file ? "active" : ""}>
              <button className="link" onClick={() => load(m.file)}>
                {m.name} <span className="muted">{m.width}×{m.height}</span>
              </button>
              <span className="row-actions">
                <button onClick={() => mapAction(`/api/admin/maps/${m.file}/duplicate`)}>Copy</button>
                <button
                  onClick={async () => {
                    const n = prompt("New name", m.name);
                    if (!n) return;
                    const r = await mapAction(`/api/admin/maps/${m.file}/rename`, "POST", { name: n });
                    if (r && file === m.file) {
                      setFile(r.file);
                      setName(n);
                    }
                  }}
                >
                  Rename
                </button>
                <button
                  className="danger"
                  onClick={async () => {
                    if (!confirm(`Delete ${m.name}?`)) return;
                    if (await mapAction(`/api/admin/maps/${m.file}`, "DELETE")) if (file === m.file) setFile(null);
                  }}
                >
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      </aside>

      <section className="card editor">
        <div className="editor-head">
          <input className="map-name" value={name} onChange={(e) => (setName(e.target.value), setDirty(true))} />
          <span className="muted">{file ?? "unsaved"}{dirty && " (unsaved changes)"}</span>
          <span className="spacer" />
          <label className="muted">Size</label>
          <SizeInput value={grid.width} onChange={(w) => edit(resizeGrid(grid, w, grid.height))} />
          ×
          <SizeInput value={grid.height} onChange={(h) => edit(resizeGrid(grid, grid.width, h))} />
        </div>
        <div className="brushes">
          {BRUSHES.map((b) => (
            <button key={b.kind} className={brush === b.kind ? "active" : ""} onClick={() => setBrush(b.kind)}>
              <span className="swatch" style={{ background: b.color }} /> {b.label}
              <span className="muted"> {b.kind === "floor" ? "" : counts[b.kind] ?? 0}</span>
            </button>
          ))}
        </div>
        <GridCanvas grid={grid} brush={brush} onChange={edit} />
        <p className="muted small">Click or drag to paint. Right-click erases. The outer border is always wall.</p>
      </section>

      <aside className="card side">
        <h2>Level rules</h2>
        <RulesPanel rules={rules} onChange={(r) => (setRules(r), setDirty(true))} />
        <div className="buttons">
          <button onClick={validate}>Validate</button>
          <button className="primary" onClick={save}>Save</button>
          <button
            disabled={busyMatch}
            title={busyMatch ? "A match is in progress" : "Play this map with built-in bots for a minute"}
            onClick={async () => {
              const f = dirty || !file ? await save() : file;
              if (f) send({ type: "testRun", file: f });
            }}
          >
            Test run
          </button>
        </div>
        {validation && (
          <div className={`validation ${validation.ok ? "ok" : "bad"}`}>
            <b>{validation.ok ? `Valid for ${expectedTeams} teams` : "Problems"}</b>
            <ul>
              {validation.errors.map((e) => <li key={e}>{e}</li>)}
              {validation.warnings.map((w) => <li key={w} className="warn">{w}</li>)}
            </ul>
          </div>
        )}
      </aside>
    </div>
  );
}

function SizeInput({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  const commit = () => {
    const n = Math.round(Number(v));
    if (n >= 5 && n <= 200 && n !== value) onChange(n);
    else setV(String(value));
  };
  return <input className="size" value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} />;
}

function RulesPanel({ rules, onChange }: { rules: Partial<Rules>; onChange: (r: Partial<Rules>) => void }) {
  const set = (key: keyof Rules, value: unknown) => {
    const next = { ...rules } as Record<string, unknown>;
    if (value === undefined || value === "" || value === (DEFAULT_RULES as Record<string, unknown>)[key]) delete next[key];
    else next[key] = value;
    onChange(next as Partial<Rules>);
  };
  return (
    <div className="rules">
      {RULES.map((r) => {
        const def = DEFAULT_RULES[r.key];
        const val = rules[r.key] ?? def;
        const changed = r.key in rules && rules[r.key] !== def;
        return (
          <label key={r.key} className={changed ? "changed" : ""}>
            <span>{r.label}</span>
            {r.kind === "bool" ? (
              <input type="checkbox" checked={Boolean(val)} onChange={(e) => set(r.key, e.target.checked)} />
            ) : (
              <span className="rule-input">
                {r.kind === "never" && (
                  <label className="never">
                    <input type="checkbox" checked={val === null} onChange={(e) => set(r.key, e.target.checked ? null : def)} /> never
                  </label>
                )}
                {val !== null && (
                  <input
                    type="number"
                    step={r.step ?? 1}
                    min={0}
                    value={val as number}
                    onChange={(e) => set(r.key, e.target.value === "" ? undefined : Number(e.target.value))}
                  />
                )}
                <span className="muted">{r.unit}</span>
              </span>
            )}
          </label>
        );
      })}
    </div>
  );
}

function GridCanvas({ grid, brush, onChange }: { grid: Grid; brush: CellKind; onChange: (g: Grid) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const painting = useRef<CellKind | null>(null);
  const gridRef = useRef(grid);
  gridRef.current = grid;
  const [cell, setCell] = useState(24);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const fit = () => {
      const w = boxRef.current?.clientWidth ?? 800;
      setCell(Math.max(6, Math.min(32, Math.floor(w / grid.width))));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [grid.width]);

  useEffect(() => {
    const c = ref.current!;
    const ctx = c.getContext("2d")!;
    c.width = grid.width * cell;
    c.height = grid.height * cell;
    grid.cells.forEach((k, i) => {
      const x = i % grid.width;
      const y = Math.floor(i / grid.width);
      const border = isBorder(grid, x, y);
      ctx.fillStyle = border ? "#3c4357" : COLOR[k];
      ctx.fillRect(x * cell, y * cell, cell, cell);
      if (!border && k !== "floor" && k !== "wall") {
        ctx.fillStyle = "#0008";
        ctx.font = `bold ${Math.floor(cell * 0.55)}px system-ui`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText({ gift: "G", ammo: "A", energy: "E", spawn: "S" }[k as "gift"], x * cell + cell / 2, y * cell + cell / 2 + 1);
      }
    });
    ctx.strokeStyle = "#ffffff12";
    for (let x = 0; x <= grid.width; x++) {
      ctx.beginPath();
      ctx.moveTo(x * cell + 0.5, 0);
      ctx.lineTo(x * cell + 0.5, c.height);
      ctx.stroke();
    }
    for (let y = 0; y <= grid.height; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * cell + 0.5);
      ctx.lineTo(c.width, y * cell + 0.5);
      ctx.stroke();
    }
    if (hover !== null) {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.strokeRect((hover % grid.width) * cell + 1, Math.floor(hover / grid.width) * cell + 1, cell - 2, cell - 2);
      ctx.lineWidth = 1;
    }
  }, [grid, cell, hover]);

  const cellAt = (e: React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const x = Math.floor((e.clientX - r.left) / cell);
    const y = Math.floor((e.clientY - r.top) / cell);
    if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return null;
    return { x, y, i: y * grid.width + x };
  };

  const paint = (e: React.MouseEvent) => {
    const p = cellAt(e);
    const kind = painting.current;
    if (!p || !kind) return;
    const g = gridRef.current;
    if (isBorder(g, p.x, p.y) || g.cells[p.i] === kind) return;
    const cells = g.cells.slice();
    cells[p.i] = kind;
    const giftIds = new Map(g.giftIds);
    if (kind !== "gift") giftIds.delete(p.i);
    onChange({ ...g, cells, giftIds });
  };

  return (
    <div ref={boxRef} className="grid-box">
      <canvas
        ref={ref}
        onContextMenu={(e) => e.preventDefault()}
        onMouseDown={(e) => {
          painting.current = e.button === 2 ? "floor" : brush;
          paint(e);
        }}
        onMouseMove={(e) => {
          setHover(cellAt(e)?.i ?? null);
          paint(e);
        }}
        onMouseUp={() => (painting.current = null)}
        onMouseLeave={() => {
          painting.current = null;
          setHover(null);
        }}
      />
    </div>
  );
}
