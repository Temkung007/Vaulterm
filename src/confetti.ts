/** A tiny, dependency-free confetti burst for happy moments (a session
 *  connecting). Spawns a throwaway full-window <canvas>, rains a few dozen
 *  paper bits with gravity + spin, then removes itself. Respects reduced motion.
 */

interface Bit {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  size: number;
  color: string;
  shape: "rect" | "circle";
}

const COLORS = ["#40d3c6", "#5b9dff", "#46c76a", "#e0a72e", "#e0728a", "#a78bfa"];
const GRAVITY = 0.28;
const DRAG = 0.992;

/** Fire a confetti burst. Origin defaults to the top-center of the viewport;
 *  pass an element to launch from its center instead. */
export function confettiBurst(from?: HTMLElement | null, count = 90): void {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const canvas = document.createElement("canvas");
  canvas.className = "confetti-canvas";
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  document.body.append(canvas);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    canvas.remove();
    return;
  }
  ctx.scale(dpr, dpr);

  let ox = w / 2;
  let oy = h * 0.28;
  if (from) {
    const r = from.getBoundingClientRect();
    ox = r.left + r.width / 2;
    oy = r.top + r.height / 2;
  }

  const bits: Bit[] = [];
  for (let i = 0; i < count; i++) {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.9;
    const speed = 6 + Math.random() * 8;
    bits.push({
      x: ox,
      y: oy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.4,
      size: 5 + Math.random() * 6,
      color: COLORS[(Math.random() * COLORS.length) | 0],
      shape: Math.random() < 0.5 ? "rect" : "circle",
    });
  }

  const start = performance.now();
  const LIFE = 2200;

  const frame = (now: number): void => {
    const elapsed = now - start;
    ctx.clearRect(0, 0, w, h);
    let alive = false;
    const fade = Math.max(0, 1 - elapsed / LIFE);
    for (const b of bits) {
      b.vx *= DRAG;
      b.vy = b.vy * DRAG + GRAVITY;
      b.x += b.vx;
      b.y += b.vy;
      b.rot += b.vr;
      if (b.y < h + 20) alive = true;
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.translate(b.x, b.y);
      ctx.rotate(b.rot);
      ctx.fillStyle = b.color;
      if (b.shape === "rect") {
        ctx.fillRect(-b.size / 2, -b.size / 2, b.size, b.size * 0.6);
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, b.size / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    if (alive && elapsed < LIFE) {
      requestAnimationFrame(frame);
    } else {
      canvas.remove();
    }
  };
  requestAnimationFrame(frame);
}
