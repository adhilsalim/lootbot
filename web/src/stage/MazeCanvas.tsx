import { useEffect, useRef } from "react";
import { wallSet, type MapFile, type TeamProfileView, type WorldView } from "@lootbot/shared";

interface Props {
  map: MapFile;
  world: WorldView | null;
  profiles: Map<string, TeamProfileView>;
  /** Milliseconds between ticks, for smoothing car motion. */
  tickMs: number;
  /** Team whose audio clip is playing: draws a glowing ring around its car. */
  glowTeam?: string | null;
}

const COLORS = { floor: "#1b1f2a", grid: "#232836", wall: "#5b6478", wallTop: "#7a849b" };

/** Draws the maze, items, cars and shots on a canvas that fills its container. */
export function MazeCanvas({ map, world, profiles, tickMs, glowTeam }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const prev = useRef<{ world: WorldView | null; at: number }>({ world: null, at: 0 });
  const cur = useRef<{ world: WorldView | null; at: number }>({ world: null, at: 0 });
  const images = useRef(new Map<string, HTMLImageElement>());
  const glow = useRef(glowTeam);
  glow.current = glowTeam;

  // Keep the previous world so cars glide from their last position.
  useEffect(() => {
    if (world && world.tick !== cur.current.world?.tick) {
      prev.current = cur.current.world && world.tick === cur.current.world.tick + 1 ? cur.current : { world, at: performance.now() };
      cur.current = { world, at: performance.now() };
    }
  }, [world]);

  useEffect(() => {
    for (const p of profiles.values()) {
      if (p.icon && !images.current.has(p.icon)) {
        const img = new Image();
        img.src = p.icon;
        images.current.set(p.icon, img);
      }
    }
  }, [profiles]);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const walls = wallSet(map);
    let raf = 0;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const box = canvas.parentElement!.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const cell = Math.floor(Math.min(box.width / map.width, box.height / map.height));
      const w = cell * map.width;
      const h = cell * map.height;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const now = performance.now();

      // Floor and grid.
      ctx.fillStyle = COLORS.floor;
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = COLORS.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= map.width; x++) {
        ctx.moveTo(x * cell + 0.5, 0);
        ctx.lineTo(x * cell + 0.5, h);
      }
      for (let y = 0; y <= map.height; y++) {
        ctx.moveTo(0, y * cell + 0.5);
        ctx.lineTo(w, y * cell + 0.5);
      }
      ctx.stroke();

      // Walls.
      for (const k of walls) {
        const [x, y] = k.split(",").map(Number);
        ctx.fillStyle = COLORS.wall;
        ctx.fillRect(x * cell, y * cell, cell, cell);
        ctx.fillStyle = COLORS.wallTop;
        ctx.fillRect(x * cell + 2, y * cell + 2, cell - 4, cell * 0.3);
      }

      // Spawn markers.
      ctx.strokeStyle = "#3a4256";
      ctx.lineWidth = 2;
      for (const [x, y] of map.spawns) {
        ctx.strokeRect(x * cell + 4, y * cell + 4, cell - 8, cell - 8);
      }

      const wv = cur.current.world;
      if (!wv) return;

      // Items.
      for (const it of wv.items) {
        const cx = it.x * cell + cell / 2;
        const cy = it.y * cell + cell / 2;
        if (it.type === "gift") drawGift(ctx, cx, cy, cell * 0.36, now);
        else if (it.type === "ammo") drawAmmo(ctx, cx, cy, cell * 0.3);
        else drawEnergy(ctx, cx, cy, cell * 0.3);
      }

      // Cars, smoothed between the previous and current tick.
      const t = Math.min(1, (now - cur.current.at) / tickMs);
      const before = prev.current.world;
      for (const car of wv.cars) {
        if (!car.alive) continue;
        const old = before?.cars.find((c) => c.id === car.id && c.alive);
        const x = old ? lerp(old.x, car.x, t) : car.x;
        const y = old ? lerp(old.y, car.y, t) : car.y;
        const hd = old ? lerpAngle(old.heading, car.heading, t) : car.heading;
        const p = profiles.get(car.team);
        drawCar(ctx, {
          cx: x * cell + cell / 2,
          cy: y * cell + cell / 2,
          size: cell,
          heading: hd,
          color: p?.color ?? "#ccc",
          icon: p?.icon ? images.current.get(p.icon) : undefined,
          life: car.life / car.maxLife,
          protectedCar: car.protected,
          connected: car.connected,
          team: car.team,
          glow: glow.current === car.team,
          now,
        });
      }

      // Shots fade out over one tick.
      const fade = 1 - t;
      if (fade > 0) {
        for (const s of wv.shots) {
          ctx.strokeStyle = s.hit ? `rgba(255,80,80,${fade})` : `rgba(255,230,120,${fade})`;
          ctx.lineWidth = Math.max(2, cell * 0.08);
          ctx.beginPath();
          ctx.moveTo(s.from.x * cell + cell / 2, s.from.y * cell + cell / 2);
          ctx.lineTo(s.to.x * cell + cell / 2, s.to.y * cell + cell / 2);
          ctx.stroke();
        }
      }
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [map, profiles, tickMs]);

  return <canvas ref={canvasRef} className="maze" />;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
function lerpAngle(a: number, b: number, t: number) {
  const d = ((((b - a) % 360) + 540) % 360) - 180;
  return a + d * t;
}

function drawGift(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, now: number) {
  const bob = Math.sin(now / 300) * r * 0.08;
  ctx.save();
  ctx.translate(cx, cy + bob);
  ctx.fillStyle = "#ffcc33";
  ctx.fillRect(-r, -r * 0.7, r * 2, r * 1.7);
  ctx.fillStyle = "#e0452b";
  ctx.fillRect(-r * 0.18, -r * 0.7, r * 0.36, r * 1.7);
  ctx.fillRect(-r, -r * 0.05, r * 2, r * 0.3);
  ctx.beginPath();
  ctx.ellipse(-r * 0.35, -r * 0.85, r * 0.35, r * 0.2, -0.4, 0, Math.PI * 2);
  ctx.ellipse(r * 0.35, -r * 0.85, r * 0.35, r * 0.2, 0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawAmmo(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  ctx.fillStyle = "#c9a227";
  for (const dx of [-0.5, 0, 0.5]) {
    const x = cx + dx * r;
    ctx.fillRect(x - r * 0.18, cy - r * 0.4, r * 0.36, r * 1.1);
    ctx.beginPath();
    ctx.arc(x, cy - r * 0.4, r * 0.18, Math.PI, 0);
    ctx.fill();
  }
}

function drawEnergy(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  ctx.fillStyle = "#2ecc71";
  ctx.beginPath();
  ctx.roundRect(cx - r * 0.55, cy - r * 0.9, r * 1.1, r * 1.8, r * 0.25);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.moveTo(cx + r * 0.1, cy - r * 0.6);
  ctx.lineTo(cx - r * 0.3, cy + r * 0.1);
  ctx.lineTo(cx, cy + r * 0.1);
  ctx.lineTo(cx - r * 0.1, cy + r * 0.6);
  ctx.lineTo(cx + r * 0.3, cy - r * 0.1);
  ctx.lineTo(cx, cy - r * 0.1);
  ctx.closePath();
  ctx.fill();
}

interface CarDraw {
  cx: number;
  cy: number;
  size: number;
  heading: number;
  color: string;
  icon?: HTMLImageElement;
  life: number;
  protectedCar: boolean;
  connected: boolean;
  team: string;
  glow: boolean;
  now: number;
}

function drawCar(ctx: CanvasRenderingContext2D, c: CarDraw) {
  const s = c.size * 0.42;
  ctx.save();
  ctx.translate(c.cx, c.cy);

  if (c.glow) {
    const pulse = 0.6 + 0.4 * Math.sin(c.now / 150);
    ctx.strokeStyle = `rgba(255,255,160,${pulse})`;
    ctx.lineWidth = c.size * 0.12;
    ctx.shadowColor = "#ffff99";
    ctx.shadowBlur = c.size * 0.6;
    ctx.beginPath();
    ctx.arc(0, 0, c.size * 0.62, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
  if (c.protectedCar && Math.floor(c.now / 150) % 2 === 0) ctx.globalAlpha = 0.45;
  if (!c.connected) ctx.globalAlpha = 0.35;

  ctx.save();
  ctx.rotate((c.heading * Math.PI) / 180);
  ctx.fillStyle = c.color;
  ctx.beginPath();
  ctx.roundRect(-s * 0.8, -s, s * 1.6, s * 2, s * 0.35);
  ctx.fill();
  // Nose triangle shows heading.
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.moveTo(0, -s * 1.25);
  ctx.lineTo(-s * 0.4, -s * 0.7);
  ctx.lineTo(s * 0.4, -s * 0.7);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Icon stays upright.
  const r = s * 0.62;
  if (c.icon?.complete && c.icon.naturalWidth) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(c.icon, -r, -r, r * 2, r * 2);
    ctx.restore();
  } else {
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = `bold ${Math.round(r * 1.2)}px system-ui`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(c.team[0]?.toUpperCase() ?? "?", 0, 1);
  }

  // Life bar above the car.
  ctx.globalAlpha = 1;
  const bw = c.size * 0.9;
  const by = -c.size * 0.62;
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(-bw / 2, by - 4, bw, 5);
  ctx.fillStyle = c.life > 0.5 ? "#2ecc71" : c.life > 0.25 ? "#f1c40f" : "#e74c3c";
  ctx.fillRect(-bw / 2, by - 4, bw * c.life, 5);
  ctx.restore();
}
