import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Channel } from "@tauri-apps/api/core";
import "@xterm/xterm/css/xterm.css";

import * as api from "./api";
import type { Connection } from "./api";

export type SessionStatus = "connecting" | "connected" | "closed";

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
  private ro?: ResizeObserver;
  private raf = 0;

  status: SessionStatus = "connecting";
  onStatusChange?: (s: SessionStatus) => void;

  constructor(connection: Connection, sessionId: string) {
    this.connection = connection;
    this.sessionId = sessionId;

    this.element = document.createElement("div");
    this.element.className = "term-pane";

    this.term = new Terminal({
      cursorBlink: true,
      fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
      fontSize: 14,
      scrollback: 10000,
      theme: {
        background: "#0d1117",
        foreground: "#e6edf3",
        cursor: "#2f81f7",
        selectionBackground: "#264f78",
      },
    });

    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new WebLinksAddon());
  }

  /** Open the terminal, wire I/O, and start the SSH session. */
  async start(): Promise<void> {
    this.term.open(this.element);

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
      this.term.focus();
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
            this.term.focus();
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

  /** Type `text` into the remote shell (no trailing newline) and focus it.
   *  Used by the command palette to insert a snippet for the user to review. */
  sendText(text: string): void {
    api.sshWrite(this.sessionId, bytesToB64(encoder.encode(text))).catch(() => {});
    this.term.focus();
  }

  dispose(): void {
    this.ro?.disconnect();
    cancelAnimationFrame(this.raf);
    if (this.status !== "closed") api.sshClose(this.sessionId).catch(() => {});
    this.term.dispose();
    this.element.remove();
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
