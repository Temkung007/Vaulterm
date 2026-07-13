/** A tiny pixel-art monster that lives at the bottom of the sidebar — the same
 *  little "terminal monster" as the Termkin logo.
 *
 * Pure DOM + <canvas> — no assets, no dependencies. It wanders, naps, blinks,
 * and reacts: click to pet it, double-click to feed it, and it hops with joy
 * whenever an SSH session connects. A small happiness score persists in
 * localStorage (never the vault — nothing here is a secret).
 */

const STORE_KEY = "vaulterm.pet";
const DEFAULT_NAME = "Bit";

/** Color variants. K (outline), P (mouth), E (pupil) stay constant; O (body),
 *  D (horns/shadow), W (belly/eye) change per variant. '.' = clear. */
export type MonsterColor = "teal" | "grape" | "slime" | "ember";

export const MONSTER_COLORS: { id: MonsterColor; label: string }[] = [
  { id: "teal", label: "Teal 🩵" },
  { id: "grape", label: "Grape 💜" },
  { id: "slime", label: "Slime 💚" },
  { id: "ember", label: "Ember 🧡" },
];

const COATS: Record<MonsterColor, { O: string; D: string; W: string }> = {
  teal: { O: "#3fd0c4", D: "#268f86", W: "#d7f7f2" },
  grape: { O: "#a78bfa", D: "#7355c9", W: "#ece5ff" },
  slime: { O: "#7bd66a", D: "#4f9d43", W: "#e6f8df" },
  ember: { O: "#f0894e", D: "#c8632c", W: "#ffe1cd" },
};

type Palette = Record<string, string>;

/** Build the pixel palette for a monster color. */
function monsterPalette(color: MonsterColor): Palette {
  const coat = COATS[color] ?? COATS.teal;
  return {
    K: "#0f1720", // outline
    O: coat.O, // body
    D: coat.D, // horns / shadow / closed eyes
    W: coat.W, // belly / eye sclera
    P: "#e0728a", // mouth
    E: "#12223a", // pupil
  };
}

type Frame = string[];

const SPRITE_W = 18;
const SPRITE_H = 14;

// ---- Frames (18x14, front-facing monster; symmetric so flips are harmless) --

const SIT_1: Frame = [
  "..................",
  "....D........D....",
  "....DD......DD....",
  "...KDDKKKKKKDDK...",
  "...KOOOOOOOOOOK...",
  "...KOWWOOOOWWOK...",
  "...KOWEOOOOEWOK...",
  "...KOOOOOOOOOOK...",
  "...KOOOOPPOOOOK...",
  "...KOWWWWWWWWOK...",
  "...KOOOOOOOOOOK...",
  "....KOOOOOOOOK....",
  "...KWWK....KWWK...",
  "..................",
];

/** Mouth open — a little chirp. */
const SIT_2: Frame = [
  "..................",
  "....D........D....",
  "....DD......DD....",
  "...KDDKKKKKKDDK...",
  "...KOOOOOOOOOOK...",
  "...KOWWOOOOWWOK...",
  "...KOWEOOOOEWOK...",
  "...KOOOOOOOOOOK...",
  "...KOOOPPPPOOOK...",
  "...KOWWWWWWWWOK...",
  "...KOOOOOOOOOOK...",
  "....KOOOOOOOOK....",
  "...KWWK....KWWK...",
  "..................",
];

/** Eyes closed (blink / content). */
const SIT_BLINK: Frame = [
  "..................",
  "....D........D....",
  "....DD......DD....",
  "...KDDKKKKKKDDK...",
  "...KOOOOOOOOOOK...",
  "...KOOOOOOOOOOK...",
  "...KODDOOOODDOK...",
  "...KOOOOOOOOOOK...",
  "...KOOOOPPOOOOK...",
  "...KOWWWWWWWWOK...",
  "...KOOOOOOOOOOK...",
  "....KOOOOOOOOK....",
  "...KWWK....KWWK...",
  "..................",
];

/** Feet apart. */
const WALK_1: Frame = [
  "..................",
  "....D........D....",
  "....DD......DD....",
  "...KDDKKKKKKDDK...",
  "...KOOOOOOOOOOK...",
  "...KOWWOOOOWWOK...",
  "...KOWEOOOOEWOK...",
  "...KOOOOOOOOOOK...",
  "...KOOOOPPOOOOK...",
  "...KOWWWWWWWWOK...",
  "...KOOOOOOOOOOK...",
  "....KOOOOOOOOK....",
  "..KWWK......KWWK..",
  "..................",
];

/** Feet together — the other step. */
const WALK_2: Frame = [
  "..................",
  "....D........D....",
  "....DD......DD....",
  "...KDDKKKKKKDDK...",
  "...KOOOOOOOOOOK...",
  "...KOWWOOOOWWOK...",
  "...KOWEOOOOEWOK...",
  "...KOOOOOOOOOOK...",
  "...KOOOOPPOOOOK...",
  "...KOWWWWWWWWOK...",
  "...KOOOOOOOOOOK...",
  "....KOOOOOOOOK....",
  ".....KWWKKWWK.....",
  "..................",
];

const SLEEP_1: Frame = [
  "..................",
  "..................",
  "..................",
  "..................",
  ".....DD....DD.....",
  "...KKOOOOOOOOKK...",
  "..KOOOOOOOOOOOOK..",
  "..KODDOOOOOODDOK..",
  "..KOWWWWWWWWWWOK..",
  "..KOOOOOOOOOOOOK..",
  "...KKKKKKKKKKKK...",
  "..................",
  "..................",
  "..................",
];

/** One breath in — body one pixel taller. */
const SLEEP_2: Frame = [
  "..................",
  "..................",
  "..................",
  ".....DD....DD.....",
  "...KKOOOOOOOOKK...",
  "..KOOOOOOOOOOOOK..",
  "..KODDOOOOOODDOK..",
  "..KOWWWWWWWWWWOK..",
  "..KOOOOOOOOOOOOK..",
  "..KOOOOOOOOOOOOK..",
  "...KKKKKKKKKKKK...",
  "..................",
  "..................",
  "..................",
];

type PetState = "sit" | "walk" | "sleep" | "jump";

interface PetData {
  enabled: boolean;
  name: string;
  color: MonsterColor;
  /** 0–100; decays slowly over real time, floor of 5. */
  happiness: number;
  updatedAt: number;
}

function loadData(): PetData {
  const fallback: PetData = {
    enabled: true,
    name: DEFAULT_NAME,
    color: "teal",
    happiness: 80,
    updatedAt: Date.now(),
  };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return fallback;
    const d = { ...fallback, ...(JSON.parse(raw) as Partial<PetData>) };
    // Mood decays ~2 points per hour away, but the cat never looks abandoned.
    const hours = Math.max(0, (Date.now() - d.updatedAt) / 3_600_000);
    d.happiness = Math.max(5, Math.min(100, Math.round(d.happiness - hours * 2)));
    return d;
  } catch {
    return fallback;
  }
}

const FRAME_MS = 260;
const WALK_SPEED = 22; // px/s
const SCALE = 3;

export class PetPanel {
  private strip: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private data: PetData;

  private state: PetState = "sit";
  private stateUntil = 0;
  private frameAt = 0;
  private frameIdx = 0;
  private x = 20;
  private targetX = 20;
  private facing: "left" | "right" = "left";
  private jumpStart = 0;
  private lastTs = 0;
  private raf = 0;
  private palette: Palette;

  constructor(strip: HTMLElement) {
    this.strip = strip;
    this.canvas = document.createElement("canvas");
    this.canvas.width = SPRITE_W;
    this.canvas.height = SPRITE_H;
    this.canvas.className = "pet-cat";
    this.canvas.style.width = `${SPRITE_W * SCALE}px`;
    this.canvas.style.height = `${SPRITE_H * SCALE}px`;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d unavailable");
    this.ctx = ctx;
    strip.append(this.canvas);

    this.data = loadData();
    this.palette = monsterPalette(this.data.color);
    this.canvas.addEventListener("click", () => this.petted());
    this.canvas.addEventListener("dblclick", () => this.feed());

    this.applyEnabled();
  }

  // ---- public API ------------------------------------------------------------

  get enabled(): boolean {
    return this.data.enabled;
  }

  get name(): string {
    return this.data.name;
  }

  get color(): MonsterColor {
    return this.data.color;
  }

  setEnabled(on: boolean): void {
    this.data.enabled = on;
    this.save();
    this.applyEnabled();
  }

  setName(name: string): void {
    this.data.name = name.trim().slice(0, 20) || DEFAULT_NAME;
    this.save();
    this.refreshTooltip();
  }

  setColor(color: MonsterColor): void {
    this.data.color = color;
    this.palette = monsterPalette(color);
    this.save();
    this.emitBubble("✨");
    paintFrame(this.ctx, this.currentFrame(), this.palette);
  }

  /** A session connected — hop with joy. */
  celebrate(): void {
    if (!this.data.enabled) return;
    this.bump(3);
    this.enter("jump");
    this.emitBubble("♥");
  }

  // ---- interactions ----------------------------------------------------------

  private petted(): void {
    this.bump(4);
    this.emitBubble("♥");
    if (this.state === "sleep") this.enter("sit");
    else if (this.state !== "jump") this.enter("jump");
  }

  private feed(): void {
    this.bump(10);
    this.emitBubble("🍬");
    this.emitBubble("♥");
    this.enter("jump");
  }

  private bump(points: number): void {
    this.data.happiness = Math.min(100, this.data.happiness + points);
    this.save();
  }

  private save(): void {
    this.data.updatedAt = Date.now();
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(this.data));
    } catch {
      /* storage full/blocked — the cat forgives */
    }
    this.refreshTooltip();
  }

  private refreshTooltip(): void {
    const h = this.data.happiness;
    const mood = h >= 70 ? "😄" : h >= 30 ? "🙂" : "😔";
    this.canvas.title = `${this.data.name} ${mood} ${h}%\nClick to pet · double-click to feed`;
  }

  // ---- state machine ---------------------------------------------------------

  private applyEnabled(): void {
    this.strip.classList.toggle("hidden", !this.data.enabled);
    if (this.data.enabled) {
      this.refreshTooltip();
      this.enter("sit");
      if (!this.raf) {
        this.lastTs = performance.now();
        this.raf = requestAnimationFrame((t) => this.tick(t));
      }
    } else if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  private enter(state: PetState): void {
    this.state = state;
    this.frameIdx = 0;
    this.frameAt = 0;
    const now = performance.now();
    switch (state) {
      case "sit":
        this.stateUntil = now + 3000 + Math.random() * 5000;
        break;
      case "sleep":
        this.stateUntil = now + 7000 + Math.random() * 9000;
        break;
      case "jump":
        this.jumpStart = now;
        this.stateUntil = now + 700;
        break;
      case "walk": {
        const max = Math.max(10, this.strip.clientWidth - SPRITE_W * SCALE - 6);
        this.targetX = 4 + Math.random() * max;
        this.facing = this.targetX < this.x ? "left" : "right";
        this.stateUntil = now + 20_000; // safety cap; normally ends on arrival
        break;
      }
    }
  }

  private pickNext(): void {
    // Respect reduced-motion: a calmer cat that mostly sits and naps.
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const h = this.data.happiness;
    const r = Math.random();
    if (calm) {
      this.enter(r < 0.6 ? "sit" : "sleep");
      return;
    }
    if (h >= 70) this.enter(r < 0.45 ? "walk" : r < 0.8 ? "sit" : "sleep");
    else if (h >= 30) this.enter(r < 0.35 ? "walk" : r < 0.72 ? "sit" : "sleep");
    else {
      if (r < 0.55) this.enter("sleep");
      else {
        this.enter("sit");
        if (Math.random() < 0.4) this.emitBubble("…");
      }
    }
  }

  private tick(ts: number): void {
    this.raf = requestAnimationFrame((t) => this.tick(t));
    const dt = Math.min(100, ts - this.lastTs);
    this.lastTs = ts;

    if (this.state === "walk") {
      const step = (WALK_SPEED * dt) / 1000;
      if (Math.abs(this.targetX - this.x) <= step) {
        this.x = this.targetX;
        this.pickNext();
      } else {
        this.x += this.facing === "left" ? -step : step;
      }
    }
    if (ts >= this.stateUntil && this.state !== "walk") this.pickNext();

    this.frameAt += dt;
    if (this.frameAt >= FRAME_MS) {
      this.frameAt = 0;
      this.frameIdx++;
    }
    this.draw(ts);
  }

  private currentFrame(): Frame {
    switch (this.state) {
      case "walk":
        return this.frameIdx % 2 === 0 ? WALK_1 : WALK_2;
      case "sleep":
        return this.frameIdx % 8 < 4 ? SLEEP_1 : SLEEP_2;
      case "jump":
        return SIT_2;
      case "sit":
      default: {
        // Mostly sit still; flick the tail now and then, blink briefly.
        const step = this.frameIdx % 10;
        if (step === 4) return SIT_BLINK;
        return step < 8 ? SIT_1 : SIT_2;
      }
    }
  }

  private draw(ts: number): void {
    paintFrame(this.ctx, this.currentFrame(), this.palette);

    // Hop = a little parabola on top of whatever frame is showing.
    let hop = 0;
    if (this.state === "jump") {
      const t = Math.min(1, (ts - this.jumpStart) / 700);
      hop = Math.sin(t * Math.PI) * 10;
    }
    const flip = this.facing === "right" ? " scaleX(-1)" : "";
    this.canvas.style.transform = `translate(${Math.round(this.x)}px, ${-Math.round(hop)}px)${flip}`;

    // Sleeping cat gets floating Zzz.
    if (this.state === "sleep" && Math.random() < 0.004) this.emitBubble("z");
  }

  private emitBubble(text: string): void {
    const b = document.createElement("span");
    b.className = "pet-bubble";
    b.textContent = text;
    b.style.left = `${Math.round(this.x + (SPRITE_W * SCALE) / 2)}px`;
    this.strip.append(b);
    b.addEventListener("animationend", () => b.remove());
  }
}

/** Paint one sprite frame into a 1px-per-cell canvas context. */
function paintFrame(ctx: CanvasRenderingContext2D, frame: Frame, palette: Palette): void {
  ctx.clearRect(0, 0, SPRITE_W, SPRITE_H);
  for (let y = 0; y < SPRITE_H; y++) {
    const row = frame[y] ?? "";
    for (let x = 0; x < SPRITE_W; x++) {
      const color = palette[row[x]];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(x, y, 1, 1);
    }
  }
}

/** A big, stationary version of the monster for the empty-session state. It
 *  just sits, blinks, and breathes — no wandering. Click it for a hop. */
export class Mascot {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private frameIdx = 0;
  private frameAt = 0;
  private lastTs = 0;
  private raf = 0;
  private jumpStart = -1;
  private palette: Palette;

  constructor(host: HTMLElement, scale = 6) {
    this.canvas = document.createElement("canvas");
    this.canvas.width = SPRITE_W;
    this.canvas.height = SPRITE_H;
    this.canvas.className = "mascot-cat";
    this.canvas.style.width = `${SPRITE_W * scale}px`;
    this.canvas.style.height = `${SPRITE_H * scale}px`;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("canvas 2d unavailable");
    this.ctx = ctx;
    // Match the coat the user picked for the sidebar pet.
    this.palette = monsterPalette(loadData().color);
    host.append(this.canvas);
    this.canvas.addEventListener("click", () => this.hop());

    paintFrame(this.ctx, SIT_1, this.palette);
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!calm) {
      this.lastTs = performance.now();
      this.raf = requestAnimationFrame((t) => this.tick(t));
    }
  }

  /** Re-read the saved coat color and repaint (call after the pet color changes). */
  refreshColor(): void {
    this.palette = monsterPalette(loadData().color);
  }

  hop(): void {
    this.jumpStart = performance.now();
  }

  dispose(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.canvas.remove();
  }

  private tick(ts: number): void {
    this.raf = requestAnimationFrame((t) => this.tick(t));
    const dt = Math.min(100, ts - this.lastTs);
    this.lastTs = ts;
    this.frameAt += dt;
    if (this.frameAt >= FRAME_MS) {
      this.frameAt = 0;
      this.frameIdx++;
    }
    const step = this.frameIdx % 12;
    const frame = step === 5 ? SIT_BLINK : step >= 9 ? SIT_2 : SIT_1;
    paintFrame(this.ctx, frame, this.palette);

    let hop = 0;
    if (this.jumpStart >= 0) {
      const t = (ts - this.jumpStart) / 650;
      if (t >= 1) this.jumpStart = -1;
      else hop = Math.sin(t * Math.PI) * 14;
    }
    this.canvas.style.transform = `translateY(${-Math.round(hop)}px)`;
  }
}
