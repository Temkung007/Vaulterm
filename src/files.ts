import { open, save } from "@tauri-apps/plugin-dialog";
import * as api from "./api";
import type { Connection, FileEntry } from "./api";
import { CodeEditor } from "./editor";

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
function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
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
  private breadcrumbEl = $<HTMLElement>("files-breadcrumbs");
  private filterEl = $<HTMLInputElement>("files-filter");
  private listEl = $<HTMLUListElement>("files-list");
  private openPathEl = $<HTMLSpanElement>("files-openpath");
  private saveBtn = $<HTMLButtonElement>("files-save");
  private editor: CodeEditor;
  private statusEl = $<HTMLDivElement>("files-status");

  private conn?: Connection;
  private currentPath = "/";
  /** Unfiltered entries for the current directory (the filter box works on these). */
  private entries: FileEntry[] = [];
  private openPath: string | null = null;
  /** mtime + size of the open file when read — baseline for the stale-write guard. */
  private openMtime: number | null = null;
  private openSize: number | null = null;
  /** Overwrite already confirmed for the currently-open file (no re-nag on re-save). */
  private confirmedThisOpen = false;
  private dirty = false;

  constructor() {
    $("files-close").addEventListener("click", () => this.close());
    $("files-up").addEventListener("click", () => void this.navigate(parentPath(this.currentPath)));
    $("files-refresh").addEventListener("click", () => void this.navigate(this.currentPath));
    $("files-newfile").addEventListener("click", () => void this.newFile());
    $("files-newfolder").addEventListener("click", () => void this.newFolder());
    $("files-upload").addEventListener("click", () => void this.uploadFiles());
    this.saveBtn.addEventListener("click", () => void this.save());

    // Editor tools.
    $("files-find").addEventListener("click", () => this.editor.openFind());
    $("files-goto").addEventListener("click", () => this.editor.goToLine());
    $("files-wrap").addEventListener("click", (e) => {
      const on = this.editor.toggleWrap();
      (e.currentTarget as HTMLElement).classList.toggle("icon-btn--active", on);
    });

    // Type a path + Enter to jump anywhere; Escape/blur restores the current dir.
    this.pathEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const target = this.pathEl.value.trim();
        if (target) void this.navigate(target);
      } else if (e.key === "Escape") {
        // Cancel the edit only — don't let it bubble to the browser-close handler.
        e.stopPropagation();
        this.pathEl.value = this.currentPath;
        this.pathEl.blur();
      }
    });
    this.pathEl.addEventListener("blur", () => {
      this.pathEl.value = this.currentPath;
    });

    // Client-side filter of the current directory (no extra round-trip).
    this.filterEl.addEventListener("input", () => this.applyFilter());
    this.filterEl.addEventListener("keydown", (e) => {
      // Escape clears the filter (or blurs) instead of closing the browser.
      if (e.key === "Escape") {
        e.stopPropagation();
        if (this.filterEl.value) {
          this.filterEl.value = "";
          this.applyFilter();
        } else {
          this.filterEl.blur();
        }
      }
    });

    this.editor = new CodeEditor(
      $("files-editor"),
      () => this.setDirty(true),
      () => void this.save(),
    );
    this.backdrop.addEventListener("mousedown", (e) => {
      if (e.target === this.backdrop) this.close();
    });
    document.addEventListener(
      "keydown",
      (e) => {
        if (!this.isOpen) return;
        // Ctrl/Cmd+S saves even when focus is in the file list (the editor has
        // its own handler, so only step in when focus is outside it to avoid a
        // double save).
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
          if ($("files-editor").contains(document.activeElement)) return;
          e.preventDefault();
          if (this.openPath && this.dirty) void this.save();
        }
      },
      true,
    );
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !this.isOpen) return;
      if ($("files-editor").contains(document.activeElement)) return;
      // Inputs (path/filter) handle their own Escape — don't close over them.
      if (e.target instanceof HTMLInputElement) return;
      this.close();
    });
  }

  get isOpen(): boolean {
    return !this.backdrop.classList.contains("hidden");
  }

  /** True when the open file has unsaved edits (used by the window-close guard). */
  get isDirty(): boolean {
    return this.dirty;
  }

  async open(conn: Connection): Promise<void> {
    this.conn = conn;
    this.titleEl.textContent = `📁 ${conn.username}@${conn.host}`;
    this.clearEditor();
    this.listEl.replaceChildren();
    this.breadcrumbEl.replaceChildren();
    this.entries = [];
    this.pathEl.value = "";
    this.filterEl.value = "";
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
      this.entries = entries;
      this.filterEl.value = "";
      this.renderBreadcrumbs();
      this.renderList(entries);
      this.setStatus("");
    } catch (e) {
      this.setStatus(errText(e), "error");
      this.pathEl.value = this.currentPath;
    }
  }

  /** Clickable path segments: `/ › etc › nginx`, each navigating to its prefix. */
  private renderBreadcrumbs(): void {
    this.breadcrumbEl.replaceChildren();
    const root = el("button", "files__crumb", "/");
    root.addEventListener("click", () => void this.navigate("/"));
    this.breadcrumbEl.append(root);
    let cum = "";
    for (const seg of this.currentPath.split("/").filter(Boolean)) {
      cum += "/" + seg;
      const target = cum;
      this.breadcrumbEl.append(el("span", "files__crumb-sep", "›"));
      const crumb = el("button", "files__crumb", seg);
      crumb.addEventListener("click", () => void this.navigate(target));
      this.breadcrumbEl.append(crumb);
    }
  }

  /** Re-render the list restricted to entries matching the filter box. */
  private applyFilter(): void {
    const q = this.filterEl.value.trim().toLowerCase();
    this.renderList(q ? this.entries.filter((e) => e.name.toLowerCase().includes(q)) : this.entries);
  }

  private renderList(entries: FileEntry[]): void {
    this.listEl.replaceChildren();

    if (this.currentPath !== "/") {
      const up = el("li", "files__item files__item--dir");
      up.append(el("span", "files__icon", "📁"), el("span", "files__name", ".."));
      up.addEventListener("click", () => void this.navigate(parentPath(this.currentPath)));
      this.listEl.append(up);
    }

    if (entries.length === 0) {
      const empty = el("li", "files__empty", this.entries.length ? "No matches" : "Empty");
      this.listEl.append(empty);
      return;
    }

    for (const entry of entries) {
      const item = el("li", `files__item${entry.isDir ? " files__item--dir" : ""}`);
      const icon = entry.isSymlink ? "🔗" : entry.isDir ? "📁" : "📄";
      item.append(el("span", "files__icon", icon));
      item.append(el("span", "files__name", entry.name));
      if (!entry.isDir) item.append(el("span", "files__size", fmtSize(entry.size)));

      const full = joinPath(this.currentPath, entry.name);

      const acts = el("div", "files__item-actions");
      if (!entry.isDir) {
        const dl = el("button", "icon-btn", "⬇");
        dl.title = "Download";
        dl.addEventListener("click", (e) => {
          e.stopPropagation();
          void this.downloadFile(entry.name, full);
        });
        acts.append(dl);
      }
      const rn = el("button", "icon-btn", "✎");
      rn.title = "Rename";
      rn.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.renameItem(entry.name, full);
      });
      const del = el("button", "icon-btn icon-btn--danger", "🗑");
      del.title = "Delete";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.deleteItem(entry, full);
      });
      acts.append(rn, del);
      item.append(acts);

      item.addEventListener("click", () => {
        if (entry.isDir) void this.navigate(full);
        else void this.loadFile(full);
      });
      this.listEl.append(item);
    }
  }

  // ---- file operations ----
  private async uploadFiles(): Promise<void> {
    if (!this.conn) return;
    const sel = await open({ multiple: true, directory: false, title: "Upload files" });
    if (!sel) return;
    const locals = Array.isArray(sel) ? sel : [sel];
    this.setStatus(`Uploading ${locals.length} file(s)…`);
    try {
      for (const local of locals) {
        await api.sftpUpload(this.conn.id, local, joinPath(this.currentPath, basename(local)));
      }
      await this.navigate(this.currentPath);
      this.setStatus(`Uploaded ${locals.length} file(s)`, "ok");
    } catch (e) {
      this.setStatus(errText(e), "error");
    }
  }

  private async newFile(): Promise<void> {
    if (!this.conn) return;
    // Decide about the currently-open file's unsaved edits before touching the
    // server, so cancelling here leaves no orphan file and no state desync.
    if (this.dirty && !confirm("Discard unsaved changes to the current file?")) return;
    const name = prompt("New file name:");
    if (!name || !name.trim()) return;
    const clean = name.trim();
    if (clean.includes("/")) {
      this.setStatus("File name cannot contain '/'", "error");
      return;
    }
    if (this.entries.some((e) => e.name === clean)) {
      this.setStatus(`"${clean}" already exists here`, "error");
      return;
    }
    const full = joinPath(this.currentPath, clean);
    try {
      // force=true: it's a brand-new file, there's nothing to conflict with.
      await api.sftpWrite(this.conn.id, full, "", true, null, null);
      await this.navigate(this.currentPath);
      await this.loadFile(full);
      this.setStatus(`Created ${clean}`, "ok");
    } catch (e) {
      this.setStatus(errText(e), "error");
    }
  }

  private async newFolder(): Promise<void> {
    if (!this.conn) return;
    const name = prompt("New folder name:");
    if (!name || !name.trim()) return;
    try {
      await api.sftpMkdir(this.conn.id, joinPath(this.currentPath, name.trim()));
      await this.navigate(this.currentPath);
      this.setStatus(`Created ${name.trim()}`, "ok");
    } catch (e) {
      this.setStatus(errText(e), "error");
    }
  }

  private async downloadFile(name: string, remote: string): Promise<void> {
    if (!this.conn) return;
    const dest = await save({ defaultPath: name, title: "Save file as" });
    if (!dest) return;
    this.setStatus(`Downloading ${name}…`);
    try {
      await api.sftpDownload(this.conn.id, remote, dest);
      this.setStatus(`Downloaded to ${dest}`, "ok");
    } catch (e) {
      this.setStatus(errText(e), "error");
    }
  }

  private async renameItem(name: string, full: string): Promise<void> {
    if (!this.conn) return;
    const next = prompt(`Rename "${name}" to:`, name);
    if (!next || !next.trim() || next.trim() === name) return;
    const target = joinPath(this.currentPath, next.trim());
    try {
      await api.sftpRename(this.conn.id, full, target);
      // Keep the open-file path in sync if it (or a parent dir of it) was renamed.
      if (this.openPath === full) {
        this.openPath = target;
        this.openPathEl.textContent = target;
      } else if (this.openPath && this.openPath.startsWith(full + "/")) {
        this.openPath = target + this.openPath.slice(full.length);
        this.openPathEl.textContent = this.openPath;
      }
      await this.navigate(this.currentPath);
      this.setStatus("Renamed", "ok");
    } catch (e) {
      this.setStatus(errText(e), "error");
    }
  }

  private async deleteItem(entry: FileEntry, full: string): Promise<void> {
    if (!this.conn) return;
    // Deleting the file you're editing would discard unsaved edits — guard it.
    if (
      this.openPath === full &&
      this.dirty &&
      !confirm("You have unsaved changes to this file — delete and lose them?")
    ) {
      return;
    }
    const what = entry.isDir
      ? `folder "${entry.name}" and everything inside it`
      : `file "${entry.name}"`;
    if (!confirm(`Delete ${what} on ${this.conn.host}?\n\nThis cannot be undone.`)) return;
    this.setStatus(`Deleting ${entry.name}…`);
    try {
      await api.sftpDelete(this.conn.id, full, entry.isDir);
      if (this.openPath === full) this.clearEditor();
      await this.navigate(this.currentPath);
      this.setStatus(`Deleted ${entry.name}`, "ok");
    } catch (e) {
      this.setStatus(errText(e), "error");
    }
  }

  private async loadFile(path: string): Promise<void> {
    if (!this.conn) return;
    if (this.dirty && !confirm("Discard unsaved changes to the current file?")) return;
    this.setStatus("Opening…");
    try {
      const file = await api.sftpRead(this.conn.id, path);
      this.editor.setContent(file.content, path);
      this.openPath = path;
      this.openMtime = file.mtime;
      this.openSize = file.size;
      this.confirmedThisOpen = false;
      this.openPathEl.textContent = path;
      this.setDirty(false);
      this.setStatus("");
      this.editor.focus();
    } catch (e) {
      this.setStatus(errText(e), "error");
    }
  }

  private async save(): Promise<void> {
    // Nothing to write if the buffer is clean (also short-circuits a Ctrl+S in
    // the editor on a freshly-opened, unmodified file).
    if (!this.conn || !this.openPath || !this.dirty) return;
    // Confirm the overwrite once per opened file — routine re-saves (e.g. repeated
    // Ctrl+S) don't re-nag. The stale-file guard in doSave() always fires and is
    // the real protection against clobbering someone else's changes.
    if (!this.confirmedThisOpen) {
      const ok = confirm(
        `Save changes to:\n${this.openPath}\n\non ${this.conn.username}@${this.conn.host}\n\n` +
          `This overwrites the remote file. Continue?`,
      );
      if (!ok) return;
      this.confirmedThisOpen = true;
    }
    await this.doSave(false);
  }

  /** Perform the write. `force` bypasses the stale-write check (user override). */
  private async doSave(force: boolean): Promise<void> {
    if (!this.conn || !this.openPath) return;
    this.setStatus("Saving…");
    try {
      const res = await api.sftpWrite(
        this.conn.id,
        this.openPath,
        this.editor.getContent(),
        force,
        this.openMtime,
        this.openSize,
      );
      // Advance the baseline, but never let a best-effort null erase a good one.
      if (res.mtime !== null) this.openMtime = res.mtime;
      if (res.size !== null) this.openSize = res.size;
      this.setDirty(false);
      this.setStatus(`Saved ${this.openPath}`, "ok");
    } catch (e) {
      const msg = errText(e);
      if (msg.includes("REMOTE_CHANGED")) {
        const overwrite = confirm(
          `⚠ "${this.openPath}" changed on the server since you opened it.\n\n` +
            `Saving now overwrites those external changes. Overwrite anyway?`,
        );
        if (overwrite) {
          await this.doSave(true);
        } else {
          this.setStatus("Save cancelled — file changed on the server", "error");
        }
        return;
      }
      this.setStatus(msg, "error");
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
    this.editor.clear();
    this.openPath = null;
    this.openMtime = null;
    this.openSize = null;
    this.confirmedThisOpen = false;
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
