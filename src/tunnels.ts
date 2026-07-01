import * as api from "./api";
import type { Connection, TunnelInfo } from "./api";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};
const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
};

function tunnelLabel(t: TunnelInfo): string {
  if (t.kind === "dynamic") return `SOCKS proxy · 127.0.0.1:${t.bindPort}`;
  return `Local · 127.0.0.1:${t.bindPort} → ${t.destHost}:${t.destPort}`;
}

/** Per-connection port-forwarding manager. */
export class TunnelsPanel {
  private backdrop = $<HTMLDivElement>("tun-backdrop");
  private titleEl = $<HTMLHeadingElement>("tun-title");
  private listEl = $<HTMLUListElement>("tun-list");
  private kindEl = $<HTMLSelectElement>("tun-kind");
  private bindEl = $<HTMLInputElement>("tun-bind");
  private dhostEl = $<HTMLInputElement>("tun-dhost");
  private dportEl = $<HTMLInputElement>("tun-dport");
  private localFieldsEl = $<HTMLDivElement>("tun-local-fields");
  private msgEl = $<HTMLParagraphElement>("tun-msg");
  private conn?: Connection;

  constructor() {
    $("tun-close").addEventListener("click", () => this.close());
    $("tun-start").addEventListener("click", () => void this.start());
    this.kindEl.addEventListener("change", () => this.syncKind());
    this.backdrop.addEventListener("mousedown", (e) => {
      if (e.target === this.backdrop) this.close();
    });
  }

  async open(conn: Connection): Promise<void> {
    this.conn = conn;
    this.titleEl.textContent = `🚇 Tunnels — ${conn.name || conn.host}`;
    this.msgEl.classList.add("hidden");
    this.syncKind();
    this.backdrop.classList.remove("hidden");
    await this.refresh();
  }

  close(): void {
    this.backdrop.classList.add("hidden");
    this.conn = undefined;
  }

  hideForLock(): void {
    this.close();
  }

  private syncKind(): void {
    this.localFieldsEl.style.display = this.kindEl.value === "local" ? "" : "none";
  }

  private async refresh(): Promise<void> {
    if (!this.conn) return;
    try {
      const all = await api.tunnelList();
      this.render(all.filter((t) => t.connectionId === this.conn!.id));
    } catch {
      this.render([]);
    }
  }

  private render(tunnels: TunnelInfo[]): void {
    this.listEl.replaceChildren();
    if (tunnels.length === 0) {
      this.listEl.append(el("li", "tun-empty", "No active tunnels for this connection."));
      return;
    }
    for (const t of tunnels) {
      const item = el("li", "tun-item");
      item.append(el("span", "tun-item__label", tunnelLabel(t)));
      const stop = el("button", "btn btn--ghost", "Stop");
      stop.addEventListener("click", () => void this.stop(t.id));
      item.append(stop);
      this.listEl.append(item);
    }
  }

  private async stop(id: string): Promise<void> {
    try {
      await api.tunnelStop(id);
    } catch {
      /* ignore */
    }
    await this.refresh();
  }

  private async start(): Promise<void> {
    if (!this.conn) return;
    const kind = this.kindEl.value as "local" | "dynamic";
    const bind = Number(this.bindEl.value);
    if (!Number.isInteger(bind) || bind < 1 || bind > 65535) {
      return this.showMsg("Enter a local port (1–65535).");
    }
    let destHost = "";
    let destPort = 0;
    if (kind === "local") {
      destHost = this.dhostEl.value.trim();
      destPort = Number(this.dportEl.value);
      if (!destHost) return this.showMsg("Enter a destination host.");
      if (!Number.isInteger(destPort) || destPort < 1 || destPort > 65535) {
        return this.showMsg("Enter a destination port (1–65535).");
      }
    }
    this.showMsg("Starting…");
    try {
      await api.tunnelStart(this.conn.id, kind, bind, destHost, destPort);
      this.msgEl.classList.add("hidden");
      this.bindEl.value = "";
      this.dhostEl.value = "";
      this.dportEl.value = "";
      await this.refresh();
    } catch (e) {
      this.showMsg(typeof e === "string" ? e : String(e));
    }
  }

  private showMsg(text: string): void {
    this.msgEl.textContent = text;
    this.msgEl.classList.remove("hidden");
  }
}
