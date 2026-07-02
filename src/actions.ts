import * as api from "./api";
import type { Connection, ConnAction } from "./api";

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
function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  return String(e);
}

export interface ActionsPanelOptions {
  /** Run the action's command on the server (opens a terminal to it). */
  onRun: (conn: Connection, action: ConnAction) => void;
  /** Called after actions change so the caller can refresh its connection list. */
  onChanged: (conn: Connection) => void | Promise<void>;
}

/**
 * Per-connection one-click commands (e.g. "Deploy"). Lists the actions with a
 * Run button, and lets the user add/remove them. Editing re-saves the connection
 * with `secret`/`keyText` omitted, so stored credentials are preserved.
 */
export class ActionsPanel {
  private backdrop = $<HTMLDivElement>("act-backdrop");
  private titleEl = $<HTMLHeadingElement>("act-title");
  private listEl = $<HTMLUListElement>("act-list");
  private nameEl = $<HTMLInputElement>("act-name");
  private cmdEl = $<HTMLTextAreaElement>("act-command");
  private msgEl = $<HTMLParagraphElement>("act-msg");
  private conn?: Connection;

  constructor(private opts: ActionsPanelOptions) {
    $("act-close").addEventListener("click", () => this.close());
    $("act-add").addEventListener("click", () => void this.add());
    this.backdrop.addEventListener("mousedown", (e) => {
      if (e.target === this.backdrop) this.close();
    });
  }

  open(conn: Connection): void {
    this.conn = conn;
    this.titleEl.textContent = `⚡ Actions — ${conn.name || conn.host}`;
    this.msgEl.classList.add("hidden");
    this.nameEl.value = "";
    this.cmdEl.value = "";
    this.render();
    this.backdrop.classList.remove("hidden");
  }

  close(): void {
    this.backdrop.classList.add("hidden");
    this.conn = undefined;
  }

  hideForLock(): void {
    this.close();
  }

  private render(): void {
    this.listEl.replaceChildren();
    const actions = this.conn?.actions ?? [];
    if (actions.length === 0) {
      this.listEl.append(el("li", "tun-empty", "No actions yet. Add one below (e.g. Deploy)."));
      return;
    }
    actions.forEach((a, i) => {
      const item = el("li", "tun-item");
      const label = el("div", "act-item__label");
      label.append(el("span", "act-item__name", a.name));
      label.append(el("span", "act-item__cmd", a.command));
      item.append(label);
      const run = el("button", "btn btn--primary btn--sm", "▶ Run");
      run.addEventListener("click", () => this.run(a));
      const del = el("button", "icon-btn icon-btn--danger", "🗑");
      del.title = "Delete action";
      del.addEventListener("click", () => void this.remove(i));
      item.append(run, del);
      this.listEl.append(item);
    });
  }

  private run(a: ConnAction): void {
    if (!this.conn) return;
    const conn = this.conn;
    this.close();
    this.opts.onRun(conn, a);
  }

  private async add(): Promise<void> {
    if (!this.conn) return;
    const name = this.nameEl.value.trim();
    const command = this.cmdEl.value.trim();
    if (!name) return this.showMsg("Enter a name.");
    if (!command) return this.showMsg("Enter a command.");
    await this.persist([...(this.conn.actions ?? []), { name, command }]);
    this.nameEl.value = "";
    this.cmdEl.value = "";
  }

  private async remove(index: number): Promise<void> {
    if (!this.conn) return;
    await this.persist((this.conn.actions ?? []).filter((_, i) => i !== index));
  }

  private async persist(actions: ConnAction[]): Promise<void> {
    if (!this.conn) return;
    const updated: Connection = { ...this.conn, actions };
    try {
      // secret/keyText = null -> backend keeps the stored credentials.
      await api.saveConnection(updated, null, null);
      this.conn = updated;
      this.msgEl.classList.add("hidden");
      this.render();
      await this.opts.onChanged(updated);
    } catch (e) {
      this.showMsg(errText(e));
    }
  }

  private showMsg(text: string): void {
    this.msgEl.textContent = text;
    this.msgEl.classList.remove("hidden");
  }
}
