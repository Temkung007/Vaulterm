import * as api from "./api";
import type { Connection, FileEntry } from "./api";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

function joinPath(base: string, name: string): string {
  if (base === "/" || base === "") return "/" + name;
  return base.replace(/\/+$/, "") + "/" + name;
}
function parentPath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx <= 0 ? "/" : trimmed.slice(0, idx);
}
function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  return String(e);
}

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

/**
 * Remote file browser + text editor over SFTP. One overlay, reused per
 * connection. Saving always asks for confirmation before overwriting.
 */
export class FilesBrowser {
  private backdrop = $<HTMLDivElement>("files-backdrop");
  private titleEl = $<HTMLSpanElement>("files-title");
  private pathEl = $<HTMLInputElement>("files-path");
  private listEl = $<HTMLUListElement>("files-list");
  private openPathEl = $<HTMLSpanElement>("files-openpath");
  private saveBtn = $<HTMLButtonElement>("files-save");
  private contentEl = $<HTMLTextAreaElement>("files-content");
  private statusEl = $<HTMLDivElement>("files-status");

  private conn?: Connection;
  private currentPath = "/";
  private openPath: string | null = null;
  private dirty = false;

  constructor() {
    $("files-close").addEventListener("click", () => this.close());
    $("files-up").addEventListener("click", () => void this.navigate(parentPath(this.currentPath)));
    $("files-refresh").addEventListener("click", () => void this.navigate(this.currentPath));
    this.saveBtn.addEventListener("click", () => void this.save());
    this.contentEl.addEventListener("input", () => this.setDirty(true));
    this.backdrop.addEventListener("mousedown", (e) => {
      if (e.target === this.backdrop) this.close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.isOpen && document.activeElement !== this.contentEl) {
        this.close();
      }
    });
  }

  get isOpen(): boolean {
    return !this.backdrop.classList.contains("hidden");
  }

  async open(conn: Connection): Promise<void> {
    this.conn = conn;
    this.titleEl.textContent = `📁 ${conn.username}@${conn.host}`;
    this.clearEditor();
    this.listEl.replaceChildren();
    this.pathEl.value = "";
    this.backdrop.classList.remove("hidden");
    this.setStatus("Connecting…");
    try {
      const home = await api.sftpHome(conn.id);
      await this.navigate(home || ".");
    } catch (e) {
      this.setStatus(errText(e), "error");
    }
  }

  /** Force-hide without prompting (used when the vault locks). */
  hideForLock(): void {
    this.backdrop.classList.add("hidden");
    this.conn = undefined;
    this.clearEditor();
  }

  close(): void {
    if (this.dirty && !confirm("Discard unsaved changes and close?")) return;
    this.backdrop.classList.add("hidden");
    this.conn = undefined;
    this.clearEditor();
  }

  private async navigate(path: string): Promise<void> {
    if (!this.conn) return;
    this.setStatus("Loading…");
    try {
      const entries = await api.sftpList(this.conn.id, path);
      this.currentPath = path;
      this.pathEl.value = path;
      this.renderList(entries);
      this.setStatus("");
    } catch (e) {
      this.setStatus(errText(e), "error");
    }
  }

  private renderList(entries: FileEntry[]): void {
    this.listEl.replaceChildren();

    if (this.currentPath !== "/") {
      const up = el("li", "files__item files__item--dir");
      up.append(el("span", "files__icon", "📁"), el("span", "files__name", ".."));
      up.addEventListener("click", () => void this.navigate(parentPath(this.currentPath)));
      this.listEl.append(up);
    }

    for (const entry of entries) {
      const item = el("li", `files__item${entry.isDir ? " files__item--dir" : ""}`);
      item.append(el("span", "files__icon", entry.isDir ? "📁" : "📄"));
      item.append(el("span", "files__name", entry.name));
      if (!entry.isDir) item.append(el("span", "files__size", fmtSize(entry.size)));

      const full = joinPath(this.currentPath, entry.name);
      item.addEventListener("click", () => {
        if (entry.isDir) void this.navigate(full);
        else void this.loadFile(full);
      });
      this.listEl.append(item);
    }
  }

  private async loadFile(path: string): Promise<void> {
    if (!this.conn) return;
    if (this.dirty && !confirm("Discard unsaved changes to the current file?")) return;
    this.setStatus("Opening…");
    try {
      const content = await api.sftpRead(this.conn.id, path);
      this.contentEl.value = content;
      this.contentEl.readOnly = false;
      this.openPath = path;
      this.openPathEl.textContent = path;
      this.setDirty(false);
      this.setStatus("");
      this.contentEl.focus();
    } catch (e) {
      this.setStatus(errText(e), "error");
    }
  }

  private async save(): Promise<void> {
    if (!this.conn || !this.openPath) return;
    // The required confirmation before any remote write.
    const ok = confirm(
      `Save changes to:\n${this.openPath}\n\non ${this.conn.username}@${this.conn.host}\n\n` +
        `This overwrites the remote file. Continue?`,
    );
    if (!ok) return;
    this.setStatus("Saving…");
    try {
      await api.sftpWrite(this.conn.id, this.openPath, this.contentEl.value);
      this.setDirty(false);
      this.setStatus(`Saved ${this.openPath}`, "ok");
    } catch (e) {
      this.setStatus(errText(e), "error");
    }
  }

  private setDirty(d: boolean): void {
    this.dirty = d;
    this.saveBtn.disabled = !d || !this.openPath;
    if (this.openPath) {
      this.openPathEl.textContent = d ? `● ${this.openPath}` : this.openPath;
    }
  }

  private clearEditor(): void {
    this.contentEl.value = "";
    this.contentEl.readOnly = true;
    this.openPath = null;
    this.openPathEl.textContent = "No file open";
    this.dirty = false;
    this.saveBtn.disabled = true;
  }

  private setStatus(msg: string, kind: "" | "error" | "ok" = ""): void {
    this.statusEl.textContent = msg;
    this.statusEl.classList.toggle("error", kind === "error");
    this.statusEl.classList.toggle("ok", kind === "ok");
  }
}
