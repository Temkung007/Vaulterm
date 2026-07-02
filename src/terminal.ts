import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import { Channel } from "@tauri-apps/api/core";
import "@xterm/xterm/css/xterm.css";

import * as api from "./api";
import type { Connection } from "./api";

export type SessionStatus = "connecting" | "connected" | "closed";

export const DEFAULT_THEME = "Vaulterm Dark";

/** Terminal color themes (name -> xterm ITheme). */
export const TERMINAL_THEMES: Record<string, ITheme> = {
  "Vaulterm Dark": {
    background: "#0d1117",
    foreground: "#e6edf3",
    cursor: "#2f81f7",
    selectionBackground: "#264f78",
  },
  Dracula: {
    background: "#282a36",
    foreground: "#f8f8f2",
    cursor: "#f8f8f2",
    selectionBackground: "#44475a",
    black: "#21222c",
    red: "#ff5555",
    green: "#50fa7b",
    yellow: "#f1fa8c",
    blue: "#bd93f9",
    magenta: "#ff79c6",
    cyan: "#8be9fd",
    white: "#f8f8f2",
    brightBlack: "#6272a4",
    brightRed: "#ff6e6e",
    brightGreen: "#69ff94",
    brightYellow: "#ffffa5",
    brightBlue: "#d6acff",
    brightMagenta: "#ff92df",
    brightCyan: "#a4ffff",
    brightWhite: "#ffffff",
  },
  "Solarized Dark": {
    background: "#002b36",
    foreground: "#93a1a1",
    cursor: "#93a1a1",
    selectionBackground: "#073642",
    black: "#073642",
    red: "#dc322f",
    green: "#859900",
    yellow: "#b58900",
    blue: "#268bd2",
    magenta: "#d33682",
    cyan: "#2aa198",
    white: "#eee8d5",
    brightBlack: "#586e75",
    brightRed: "#cb4b16",
    brightGreen: "#586e75",
    brightYellow: "#657b83",
    brightBlue: "#839496",
    brightMagenta: "#6c71c4",
    brightCyan: "#93a1a1",
    brightWhite: "#fdf6e3",
  },
  Light: {
    background: "#ffffff",
    foreground: "#24292f",
    cursor: "#0969da",
    selectionBackground: "#b6d7ff",
    black: "#24292f",
    red: "#cf222e",
    green: "#116329",
    yellow: "#7d4e00",
    blue: "#0969da",
    magenta: "#8250df",
    cyan: "#1b7c83",
    white: "#6e7781",
    brightBlack: "#57606a",
    brightRed: "#a40e26",
    brightGreen: "#1a7f37",
    brightYellow: "#633c01",
    brightBlue: "#218bff",
    brightMagenta: "#a475f9",
    brightCyan: "#3192aa",
    brightWhite: "#8c959f",
  },
};

export interface TerminalPrefs {
  fontSize?: number;
  themeName?: string;
  onZoom?: (delta: number | "reset") => void;
}

const SEARCH_DECORATIONS = {
  matchBackground: "#d2992255",
  matchOverviewRuler: "#d29922",
  activeMatchBackground: "#2f81f7",
  activeMatchColorOverviewRuler: "#2f81f7",
};

const encoder = new TextEncoder();

// Binary-safe base64 <-> bytes. We never TextDecode PTY output into a string —
// multi-byte UTF-8 / escape sequences can split across chunks, so we hand the
// raw bytes to xterm, whose internal decoder reassembles the stream.
function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** One xterm terminal bound to one backend SSH session (one tab). */
export class TerminalSession {
  readonly sessionId: string;
  readonly connection: Connection;
  readonly element: HTMLDivElement;

  private term: Terminal;
  private fit: FitAddon;
  private search: SearchAddon;
  private ro?: ResizeObserver;
  private raf = 0;
  private onZoom?: (delta: number | "reset") => void;

  private body: HTMLDivElement;
  /** A command to run once, after connect + startup commands (quick actions). */
  private runOnConnect?: string;
  private searchBar?: HTMLDivElement;
  private searchInput?: HTMLInputElement;
  private searchCount?: HTMLSpanElement;

  status: SessionStatus = "connecting";
  onStatusChange?: (s: SessionStatus) => void;
  /** Fired when this pane gains focus (used to track the active pane). */
  onFocus?: () => void;
  /** Fired when the pane's own close button (shown when tiled) is clicked. */
  onRequestClose?: () => void;
  /** Whether this pane is the active one. When set, connect-time and
   *  startup-command focus is suppressed for non-active panes so a late SSH
   *  connect can't steal keyboard focus from a pane the user switched to. */
  isActive?: () => boolean;

  constructor(
    connection: Connection,
    sessionId: string,
    prefs?: TerminalPrefs,
    runOnConnect?: string,
  ) {
    this.connection = connection;
    this.sessionId = sessionId;
    this.onZoom = prefs?.onZoom;
    this.runOnConnect = runOnConnect;

    this.element = document.createElement("div");
    this.element.className = "term-pane";

    // Per-pane header (title + close). Only shown when the view is split.
    const header = document.createElement("div");
    header.className = "term-pane__header";
    const title = document.createElement("span");
    title.className = "term-pane__title";
    title.textContent = connection.name || `${connection.username}@${connection.host}`;
    const close = document.createElement("button");
    close.className = "term-pane__close";
    close.type = "button";
    close.textContent = "×";
    close.title = "Close pane";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      this.onRequestClose?.();
    });
    header.append(title, close);

    this.body = document.createElement("div");
    this.body.className = "term-pane__body";
    this.element.append(header, this.body);

    // Any focus inside the pane (xterm textarea, header) marks it active.
    this.element.addEventListener("focusin", () => this.onFocus?.());
    this.element.addEventListener("mousedown", () => this.onFocus?.());

    this.term = new Terminal({
      cursorBlink: true,
      fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
      fontSize: prefs?.fontSize ?? 14,
      scrollback: 10000,
      theme: TERMINAL_THEMES[prefs?.themeName ?? DEFAULT_THEME] ?? TERMINAL_THEMES[DEFAULT_THEME],
    });

    this.fit = new FitAddon();
    this.search = new SearchAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.term.loadAddon(new WebLinksAddon());

    this.buildSearchBar();

    // Intercept Ctrl+F (search) and Ctrl+±/0 (zoom) before the shell sees them.
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || !(e.ctrlKey || e.metaKey) || e.altKey) return true;
      const k = e.key;
      let handled = true;
      if (k.toLowerCase() === "f") this.openSearch();
      else if (k === "=" || k === "+") this.onZoom?.(1);
      else if (k === "-" || k === "_") this.onZoom?.(-1);
      else if (k === "0") this.onZoom?.("reset");
      else handled = false;
      if (handled) {
        e.preventDefault();
        return false;
      }
      return true;
    });
  }

  setFontSize(size: number): void {
    this.term.options.fontSize = size;
    this.safeFit();
  }

  setTheme(themeName: string): void {
    this.term.options.theme = TERMINAL_THEMES[themeName] ?? TERMINAL_THEMES[DEFAULT_THEME];
  }

  /** Show/hide the per-pane header (used only when the view is split). */
  setTiled(tiled: boolean): void {
    this.element.classList.toggle("term-pane--tiled", tiled);
    this.refit();
  }

  /** Highlight this pane as the focused one within a split view. */
  setFocused(focused: boolean): void {
    this.element.classList.toggle("term-pane--focused", focused);
  }

  /** Re-measure and resize the grid to fit the pane (after a layout change). */
  refit(): void {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.safeFit());
  }

  /** Open the terminal, wire I/O, and start the SSH session. */
  async start(): Promise<void> {
    this.term.open(this.body);

    // First fit must run after the pane has a real size.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => {
        this.safeFit();
        resolve();
      }),
    );

    const cols = this.term.cols;
    const rows = this.term.rows;

    // Backend -> terminal (base64 chunks over an ordered channel).
    const output = new Channel<string>();
    output.onmessage = (b64) => this.term.write(b64ToBytes(b64));

    // Keystrokes / paste -> backend.
    this.term.onData((data) => {
      api.sshWrite(this.sessionId, bytesToB64(encoder.encode(data))).catch(() => {});
    });

    // Grid resize -> remote PTY winsize.
    this.term.onResize(({ cols, rows }) => {
      api.sshResize(this.sessionId, cols, rows).catch(() => {});
    });

    // Refit (and thus resize the PTY) whenever the pane changes size.
    this.ro = new ResizeObserver(() => {
      cancelAnimationFrame(this.raf);
      this.raf = requestAnimationFrame(() => this.safeFit());
    });
    this.ro.observe(this.element);

    const { username, host, port } = this.connection;
    this.term.writeln(`\x1b[90mConnecting to ${username}@${host}:${port} …\x1b[0m`);

    const attempt = (trust: boolean) =>
      api.sshOpen(this.connection.id, this.sessionId, cols, rows, output, trust);

    try {
      await attempt(false);
      this.setStatus("connected");
      this.focusIfActive();
      this.runStartupCommands();
    } catch (e) {
      if (api.isHostKeyMismatch(e)) {
        this.term.writeln(`\r\n\x1b[31m⚠ HOST KEY CHANGED for ${e.host}:${e.port}\x1b[0m`);
        this.term.writeln(`\x1b[33m  expected ${e.expected}\x1b[0m`);
        this.term.writeln(`\x1b[33m  received ${e.got}\x1b[0m`);
        const trust = confirm(
          `⚠ The host key for ${e.host}:${e.port} has CHANGED.\n\n` +
            `Expected: ${e.expected}\nReceived: ${e.got}\n\n` +
            `This can happen if the server was reinstalled or its key was rotated — ` +
            `but it can also mean a man-in-the-middle attack.\n\nTrust the new key and continue?`,
        );
        if (trust) {
          try {
            await attempt(true);
            this.setStatus("connected");
            this.focusIfActive();
            this.runStartupCommands();
          } catch (retryErr) {
            this.term.writeln(`\r\n\x1b[31m✖ ${formatError(retryErr)}\x1b[0m`);
            this.setStatus("closed");
          }
          return;
        }
        this.term.writeln(`\r\n\x1b[90m── rejected: host key not trusted ──\x1b[0m`);
        this.setStatus("closed");
        return;
      }
      this.term.writeln(`\r\n\x1b[31m✖ ${formatError(e)}\x1b[0m`);
      this.term.writeln(`\x1b[90m(press the × on the tab to close)\x1b[0m`);
      this.setStatus("closed");
    }
  }

  /** Called when the backend reports the session ended. */
  markClosed(): void {
    if (this.status !== "closed") {
      this.term.writeln(`\r\n\x1b[90m── session closed ──\x1b[0m`);
      this.setStatus("closed");
    }
  }

  focus(): void {
    this.term.focus();
    // The pane may have been resized while hidden; refit on show.
    requestAnimationFrame(() => this.safeFit());
  }

  /** Focus only if this pane is the active one (or activeness is unknown). */
  private focusIfActive(): void {
    if (!this.isActive || this.isActive()) this.term.focus();
  }

  /** Type `text` into the remote shell (no trailing newline) and focus it.
   *  Used by the command palette to insert a snippet for the user to review. */
  sendText(text: string): void {
    api.sshWrite(this.sessionId, bytesToB64(encoder.encode(text))).catch(() => {});
    this.focusIfActive();
  }

  /** Run the connection's startup commands (and any one-click action command)
   *  once the shell is ready. The action runs after the startup commands so
   *  prep like `cd /project` applies first. */
  private runStartupCommands(): void {
    const lines: string[] = [];
    const push = (s?: string) => {
      if (s?.trim()) lines.push(...s.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean));
    };
    push(this.connection.startupCommands ?? undefined);
    push(this.runOnConnect);
    if (!lines.length) return;
    const text = lines.join("\n") + "\n";
    // Let the shell draw its first prompt before sending.
    setTimeout(() => this.sendText(text), 400);
  }

  dispose(): void {
    this.ro?.disconnect();
    cancelAnimationFrame(this.raf);
    if (this.status !== "closed") api.sshClose(this.sessionId).catch(() => {});
    this.term.dispose();
    this.element.remove();
  }

  // ---- search ----
  private buildSearchBar(): void {
    const bar = document.createElement("div");
    bar.className = "term-search hidden";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Find…";
    input.className = "term-search__input";
    const count = document.createElement("span");
    count.className = "term-search__count";
    const mk = (text: string, title: string): HTMLButtonElement => {
      const b = document.createElement("button");
      b.className = "term-search__btn";
      b.textContent = text;
      b.title = title;
      b.type = "button";
      return b;
    };
    const prev = mk("↑", "Previous (Shift+Enter)");
    const next = mk("↓", "Next (Enter)");
    const close = mk("✕", "Close (Esc)");

    input.addEventListener("input", () => this.findNext(true));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey) this.findPrev();
        else this.findNext(false);
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.closeSearch();
      }
    });
    prev.addEventListener("click", () => this.findPrev());
    next.addEventListener("click", () => this.findNext(false));
    close.addEventListener("click", () => this.closeSearch());

    bar.append(input, count, prev, next, close);
    this.body.append(bar);
    this.searchBar = bar;
    this.searchInput = input;
    this.searchCount = count;

    this.search.onDidChangeResults((r) => {
      if (!this.searchCount) return;
      if (!this.searchInput?.value) {
        this.searchCount.textContent = "";
        return;
      }
      const total = r.resultCount;
      const idx = Math.max(r.resultIndex + 1, 0);
      this.searchCount.textContent = total === 0 ? "0/0" : `${idx}/${total}`;
    });
  }

  openSearch(): void {
    this.searchBar?.classList.remove("hidden");
    this.searchInput?.focus();
    this.searchInput?.select();
    if (this.searchInput?.value) this.findNext(true);
  }

  private closeSearch(): void {
    this.searchBar?.classList.add("hidden");
    this.search.clearDecorations();
    this.term.focus();
  }

  private findNext(incremental: boolean): void {
    const q = this.searchInput?.value ?? "";
    if (q) this.search.findNext(q, { incremental, decorations: SEARCH_DECORATIONS });
  }

  private findPrev(): void {
    const q = this.searchInput?.value ?? "";
    if (q) this.search.findPrevious(q, { decorations: SEARCH_DECORATIONS });
  }

  private safeFit(): void {
    try {
      this.fit.fit();
    } catch {
      /* pane detached / zero-sized */
    }
  }

  private setStatus(s: SessionStatus): void {
    this.status = s;
    this.onStatusChange?.(s);
  }
}

function formatError(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}
