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
/**
 * Join a *local* directory and one or more path segments. Unlike the remote
 * side this has to cope with Windows paths, so the separator is taken from the
 * directory the native picker handed back rather than hard-coded; `/`-separated
 * segments (which is how the backend reports paths inside a walked folder) are
 * re-joined with it.
 */
function joinLocal(dir: string, ...segments: string[]): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  const parts = segments.flatMap((s) => s.split("/")).filter(Boolean);
  return [dir.replace(/[\\/]+$/, ""), ...parts].join(sep);
}
function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  return String(e);
}

/**
 * Extensions we open in the image preview instead of the text editor, mapped to
 * the MIME type handed to the webview. Raster formats only — SVG is text, and
 * keeping it in the editor means it stays editable.
 *
 * TIFF renders on WebKit (macOS/iOS) but not on Chromium/WebView2; it's listed
 * anyway so it at least gets the preview pane, where a decode failure surfaces
 * as a clear "can't display this format" instead of a binary-file error.
 */
const IMAGE_MIME: Readonly<Record<string, string>> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jpe: "image/jpeg",
  jfif: "image/jpeg",
  png: "image/png",
  apng: "image/apng",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  cur: "image/x-icon",
  tif: "image/tiff",
  tiff: "image/tiff",
};

/** MIME type for a previewable image path, or null if it isn't one. */
function imageMimeFor(path: string): string | null {
  const name = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
  if (!name.includes(".")) return null;
  return IMAGE_MIME[name.split(".").pop()!] ?? null;
}

/**
 * Decode the base64 the backend sends into a Blob. A blob: URL (rather than a
 * data: URL) keeps the decoded bytes out of a multi-megabyte string that the
 * webview would have to re-parse — the CSP in tauri.conf.json allows blob: for
 * img-src precisely for this.
 */
function base64ToBlob(b64: string, mime: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
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
  private selectAllEl = $<HTMLInputElement>("files-selectall");
  private downloadSelEl = $<HTMLButtonElement>("files-download-sel");
  private listEl = $<HTMLUListElement>("files-list");
  private openPathEl = $<HTMLSpanElement>("files-openpath");
  private saveBtn = $<HTMLButtonElement>("files-save");
  private editor: CodeEditor;
  private editorEl = $<HTMLDivElement>("files-editor");
  private textToolsEl = $<HTMLDivElement>("files-text-tools");
  private imageToolsEl = $<HTMLDivElement>("files-image-tools");
  private previewEl = $<HTMLDivElement>("files-preview");
  private previewImgEl = $<HTMLImageElement>("files-preview-img");
  private zoomEl = $<HTMLSpanElement>("files-zoom");
  private statusEl = $<HTMLDivElement>("files-status");
  private progressEl = $<HTMLDivElement>("files-progress");
  private progressTrackEl = $<HTMLDivElement>("files-progress-track");
  private progressFillEl = $<HTMLDivElement>("files-progress-fill");
  private progressTextEl = $<HTMLSpanElement>("files-progress-text");
  private progressCancelEl = $<HTMLButtonElement>("files-progress-cancel");

  private conn?: Connection;
  private currentPath = "/";
  /** Unfiltered entries for the current directory (the filter box works on these). */
  private entries: FileEntry[] = [];
  /**
   * Names of the files ticked for a batch download. Scoped to the current
   * directory — navigating away clears it, so a selection can never span
   * folders and silently download something the user can't see.
   */
  private selected = new Set<string>();
  /** File names in display order, for shift-click range selection. */
  private selectableNames: string[] = [];
  /** Anchor for the next shift-click range. */
  private lastToggled: string | null = null;
  /** A batch transfer is running — blocks starting a second one. */
  private busy = false;
  /** Set by Cancel (or closing the browser); the transfer loop stops at the next file. */
  private cancelRequested = false;
  /** What the right-hand pane is showing: nothing, an editable file, or an image. */
  private mode: "none" | "text" | "image" = "none";
  private openPath: string | null = null;
  /** mtime + size of the open file when read — baseline for the stale-write guard. */
  private openMtime: number | null = null;
  private openSize: number | null = null;
  /** Overwrite already confirmed for the currently-open file (no re-nag on re-save). */
  private confirmedThisOpen = false;
  private dirty = false;
  /** Object URL backing the previewed image — revoked whenever the pane changes. */
  private previewUrl: string | null = null;
  private previewSize = 0;
  /** Preview scale; null means "fit to the pane". */
  private zoom: number | null = null;

  constructor() {
    $("files-close").addEventListener("click", () => this.close());
    $("files-up").addEventListener("click", () => void this.navigate(parentPath(this.currentPath)));
    $("files-refresh").addEventListener("click", () => void this.navigate(this.currentPath));
    $("files-newfile").addEventListener("click", () => void this.newFile());
    $("files-newfolder").addEventListener("click", () => void this.newFolder());
    $("files-upload").addEventListener("click", () => void this.uploadFiles());
    this.saveBtn.addEventListener("click", () => void this.save());

    // Batch selection: the header box ticks/unticks everything currently listed
    // (i.e. what the filter is showing, not the whole directory).
    this.selectAllEl.addEventListener("change", () => {
      for (const name of this.selectableNames) {
        if (this.selectAllEl.checked) this.selected.add(name);
        else this.selected.delete(name);
      }
      this.lastToggled = null;
      this.syncChecks();
    });
    this.downloadSelEl.addEventListener("click", () => void this.downloadSelected());
    this.progressCancelEl.addEventListener("click", () => {
      this.cancelRequested = true;
      this.progressCancelEl.disabled = true;
      this.progressCancelEl.textContent = "Cancelling…";
    });

    // Editor tools.
    $("files-find").addEventListener("click", () => this.editor.openFind());
    $("files-goto").addEventListener("click", () => this.editor.goToLine());
    $("files-wrap").addEventListener("click", (e) => {
      const on = this.editor.toggleWrap();
      (e.currentTarget as HTMLElement).classList.toggle("icon-btn--active", on);
    });

    // Image preview tools.
    $("files-zoom-in").addEventListener("click", () => this.zoomBy(1.25));
    $("files-zoom-out").addEventListener("click", () => this.zoomBy(1 / 1.25));
    $("files-zoom-fit").addEventListener("click", () => this.setZoom(null));
    $("files-zoom-1x").addEventListener("click", () => this.setZoom(1));
    // Double-click toggles fit ↔ actual size, the way every image viewer does.
    this.previewEl.addEventListener("dblclick", () => this.setZoom(this.zoom === null ? 1 : null));
    // Ctrl/Cmd+wheel zooms; a plain wheel still scrolls a zoomed-in image.
    this.previewEl.addEventListener(
      "wheel",
      (e) => {
        if (!e.ctrlKey && !e.metaKey) return;
        e.preventDefault();
        this.zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
      },
      { passive: false },
    );
    this.previewImgEl.addEventListener("load", () => {
      const { naturalWidth: w, naturalHeight: h } = this.previewImgEl;
      this.setStatus(`${w} × ${h} · ${fmtSize(this.previewSize)}`);
    });
    this.previewImgEl.addEventListener("error", () => {
      // Only a real (non-empty) src failing to decode is an error — clearing the
      // pane also fires this event.
      if (!this.previewImgEl.getAttribute("src")) return;
      this.setStatus(
        "Can't display this image format — download it to open it locally",
        "error",
      );
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
      // The text inputs (path/filter) handle their own Escape — don't close over
      // them. A focused selection tick box has no such handling, so Escape there
      // should still close the browser.
      if (e.target instanceof HTMLInputElement && e.target.type !== "checkbox") return;
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
    this.selected.clear();
    this.selectableNames = [];
    this.lastToggled = null;
    this.syncChecks();
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
    this.cancelRequested = true;
    this.backdrop.classList.add("hidden");
    this.conn = undefined;
    this.clearEditor();
  }

  close(): void {
    if (this.dirty && !confirm("Discard unsaved changes and close?")) return;
    if (this.busy && !confirm("A download is still running — stop it and close?")) return;
    // Stops the transfer loop after the file currently in flight.
    this.cancelRequested = true;
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
      // A selection only ever means "these files, in this folder".
      this.selected.clear();
      this.lastToggled = null;
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
    this.selectableNames = entries.map((e) => e.name);

    if (this.currentPath !== "/") {
      const up = el("li", "files__item files__item--dir");
      up.append(
        el("span", "files__check-gap"),
        el("span", "files__icon", "📁"),
        el("span", "files__name", ".."),
      );
      up.addEventListener("click", () => void this.navigate(parentPath(this.currentPath)));
      this.listEl.append(up);
    }

    if (entries.length === 0) {
      const empty = el("li", "files__empty", this.entries.length ? "No matches" : "Empty");
      this.listEl.append(empty);
      this.syncChecks();
      return;
    }

    for (const entry of entries) {
      const item = el("li", `files__item${entry.isDir ? " files__item--dir" : ""}`);
      const mime = entry.isDir ? null : imageMimeFor(entry.name);
      const icon = entry.isSymlink ? "🔗" : entry.isDir ? "📁" : mime ? "🖼" : "📄";

      // Both files and folders can be ticked; a ticked folder downloads whole.
      const check = document.createElement("input");
      check.type = "checkbox";
      check.className = "files__check";
      check.dataset.name = entry.name;
      check.checked = this.selected.has(entry.name);
      check.title = entry.isDir
        ? "Select this folder (downloads everything inside)"
        : "Select for batch download";
      // The row's own click opens the entry — a tick must not do that too.
      check.addEventListener("click", (e) => {
        e.stopPropagation();
        this.toggleSelection(entry.name, check.checked, e.shiftKey);
      });
      item.append(check);

      item.append(el("span", "files__icon", icon));
      item.append(el("span", "files__name", entry.name));
      if (!entry.isDir) item.append(el("span", "files__size", fmtSize(entry.size)));

      const full = joinPath(this.currentPath, entry.name);

      const acts = el("div", "files__item-actions");
      const dl = el("button", "icon-btn", "⬇");
      dl.title = entry.isDir ? "Download this folder" : "Download";
      dl.addEventListener("click", (e) => {
        e.stopPropagation();
        // A folder goes through the batch path (walk + progress bar); a single
        // file keeps the nicer "Save as…" dialog with an editable name.
        if (entry.isDir) void this.downloadEntries([entry]);
        else void this.downloadFile(entry.name, full);
      });
      acts.append(dl);
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
        else if (mime) void this.previewImage(full, mime);
        else void this.loadFile(full);
      });
      this.listEl.append(item);
    }
    this.syncChecks();
  }

  // ---- batch selection ----

  /**
   * Tick or untick one file. With shift held, the whole range between the last
   * box the user touched and this one takes the new state — the usual
   * file-manager shortcut for grabbing a run of files.
   */
  private toggleSelection(name: string, checked: boolean, shift: boolean): void {
    const apply = (n: string) => (checked ? this.selected.add(n) : this.selected.delete(n));
    const from = this.lastToggled ? this.selectableNames.indexOf(this.lastToggled) : -1;
    const to = this.selectableNames.indexOf(name);
    if (shift && from !== -1 && to !== -1) {
      const [lo, hi] = from < to ? [from, to] : [to, from];
      for (let i = lo; i <= hi; i++) apply(this.selectableNames[i]);
    } else {
      apply(name);
    }
    this.lastToggled = name;
    this.syncChecks();
  }

  /** Push the selection state back into the checkboxes, header box and button. */
  private syncChecks(): void {
    for (const box of this.listEl.querySelectorAll<HTMLInputElement>(".files__check")) {
      const name = box.dataset.name;
      if (name) box.checked = this.selected.has(name);
    }
    const shown = this.selectableNames.filter((n) => this.selected.has(n)).length;
    this.selectAllEl.checked = shown > 0 && shown === this.selectableNames.length;
    this.selectAllEl.indeterminate = shown > 0 && shown < this.selectableNames.length;
    this.selectAllEl.disabled = this.selectableNames.length === 0 || this.busy;
    // Count the whole selection, not just the part the filter is showing, so the
    // button never under-reports what a click is about to download.
    const total = this.selected.size;
    this.downloadSelEl.disabled = total === 0 || this.busy;
    this.downloadSelEl.textContent = total ? `⬇ Download (${total})` : "⬇ Download";
  }

  // ---- file operations ----

  private downloadSelected(): Promise<void> {
    // Walk `entries` rather than the set so the order matches the listing.
    return this.downloadEntries(this.entries.filter((e) => this.selected.has(e.name)));
  }

  /**
   * Download the given entries into one folder the user picks. Ticked folders
   * are expanded first (recursively) so the whole job is known up front — that's
   * what makes an honest "12 / 87 files" progress bar possible instead of a
   * spinner that can't say how much is left.
   *
   * Transfers run one at a time and a failure doesn't abort the run: the rest
   * still arrive and the failures are summarised at the end, which beats losing
   * an 800-file tree to one unreadable file.
   */
  private async downloadEntries(picked: FileEntry[]): Promise<void> {
    const conn = this.conn;
    if (!conn || this.busy || picked.length === 0) return;

    const folders = picked.filter((e) => e.isDir).length;
    const dest = await open({
      directory: true,
      multiple: false,
      title: `Download ${picked.length} item(s) to…`,
    });
    if (!dest || Array.isArray(dest)) return;

    // Expand folders into concrete files. Done before the confirm so the user is
    // told the real file count, not the number of things they ticked.
    type Job = { remote: string; local: string; rel: string; size: number };
    const jobs: Job[] = [];
    if (folders > 0) this.setStatus(`Scanning ${folders} folder(s)…`);
    try {
      for (const entry of picked) {
        const remote = joinPath(this.currentPath, entry.name);
        if (entry.isDir) {
          for (const f of await api.sftpWalk(conn.id, remote)) {
            jobs.push({
              remote: f.path,
              local: joinLocal(dest, entry.name, f.rel),
              rel: `${entry.name}/${f.rel}`,
              size: f.size,
            });
          }
        } else {
          jobs.push({
            remote,
            local: joinLocal(dest, entry.name),
            rel: entry.name,
            size: entry.size,
          });
        }
      }
    } catch (e) {
      this.setStatus(errText(e), "error");
      return;
    }

    if (jobs.length === 0) {
      this.setStatus("Nothing to download — the selected folder(s) are empty", "error");
      return;
    }

    const totalBytes = jobs.reduce((n, j) => n + j.size, 0);
    const what =
      folders > 0
        ? `${jobs.length} file(s) (${fmtSize(totalBytes)}), including everything inside ${folders} folder(s),`
        : `${jobs.length} file(s) (${fmtSize(totalBytes)})`;
    if (
      !confirm(
        `Download ${what} from ${conn.host} to:\n${dest}\n\n` +
          `Existing files with the same name will be overwritten.`,
      )
    ) {
      return;
    }

    this.busy = true;
    this.cancelRequested = false;
    this.beginProgress();
    this.syncChecks();

    const failed: string[] = [];
    let done = 0;
    let bytes = 0;
    try {
      for (const job of jobs) {
        if (this.cancelRequested) break;
        this.setStatus(`Downloading ${done + 1} of ${jobs.length} — ${job.rel}…`);
        try {
          await api.sftpDownload(conn.id, job.remote, job.local);
        } catch (e) {
          failed.push(`${job.rel} (${errText(e)})`);
        }
        done++;
        bytes += job.size;
        this.updateProgress(done, jobs.length, bytes, totalBytes);
      }
    } finally {
      this.busy = false;
      this.endProgress();
    }

    const ok = done - failed.length;
    if (this.cancelRequested) {
      this.setStatus(`Cancelled — ${ok} of ${jobs.length} file(s) saved to ${dest}`, "error");
    } else if (failed.length > 0) {
      // Cap the list: a broken tree can fail hundreds of files and the status
      // bar is one line.
      const shown = failed.slice(0, 3).join(", ");
      const more = failed.length > 3 ? ` (+${failed.length - 3} more)` : "";
      this.setStatus(`Downloaded ${ok} of ${jobs.length} — failed: ${shown}${more}`, "error");
    } else {
      this.setStatus(`Downloaded ${ok} file(s) to ${dest}`, "ok");
      this.selected.clear();
      this.lastToggled = null;
    }
    this.syncChecks();
  }

  // ---- transfer progress ----

  private beginProgress(): void {
    this.progressCancelEl.disabled = false;
    this.progressCancelEl.textContent = "Cancel";
    this.progressEl.classList.remove("hidden");
    this.updateProgress(0, 1, 0, 0);
  }

  /**
   * Advance the bar. The fill tracks *bytes* (a 4 MB photo shouldn't move it as
   * far as a 2 KB config file) while the label counts files, which is what the
   * user actually asked for.
   */
  private updateProgress(done: number, total: number, bytes: number, totalBytes: number): void {
    const frac = totalBytes > 0 ? bytes / totalBytes : total > 0 ? done / total : 0;
    const pct = Math.max(0, Math.min(100, frac * 100));
    this.progressFillEl.style.width = `${pct}%`;
    this.progressTrackEl.setAttribute("aria-valuenow", String(Math.round(pct)));
    this.progressTextEl.textContent = totalBytes
      ? `${done} / ${total} files · ${fmtSize(bytes)} / ${fmtSize(totalBytes)}`
      : `${done} / ${total} files`;
  }

  private endProgress(): void {
    this.progressEl.classList.add("hidden");
    this.progressFillEl.style.width = "0%";
  }

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

  /**
   * Show an image in the right-hand pane. Images can't round-trip through the
   * text editor at all (the backend rejects them as binary), so this replaces
   * the editor rather than living beside it: the pane is view-only, and the
   * editor's own state is cleared so nothing stale can be saved over the image.
   */
  private async previewImage(path: string, mime: string): Promise<void> {
    if (!this.conn) return;
    if (this.dirty && !confirm("Discard unsaved changes to the current file?")) return;
    this.setStatus("Loading image…");
    try {
      const file = await api.sftpReadBinary(this.conn.id, path);
      const url = URL.createObjectURL(base64ToBlob(file.base64, mime));
      // clearEditor() revokes any previous preview URL — take the new one after.
      this.clearEditor();
      this.previewUrl = url;
      this.previewSize = file.size;
      this.openPath = path;
      this.openPathEl.textContent = path;
      this.mode = "image";
      this.applyMode();
      this.setZoom(null);
      this.previewImgEl.src = url;
      // The real status (dimensions + size) lands in the img `load` handler.
      this.setStatus(`Decoding ${fmtSize(file.size)}…`);
    } catch (e) {
      this.setStatus(errText(e), "error");
    }
  }

  /** Show the pane that matches the current mode and hide the other one. */
  private applyMode(): void {
    const img = this.mode === "image";
    this.previewEl.classList.toggle("hidden", !img);
    this.editorEl.classList.toggle("hidden", img);
    this.imageToolsEl.classList.toggle("hidden", !img);
    this.textToolsEl.classList.toggle("hidden", img);
  }

  /** Apply a preview scale; `null` fits the image to the pane. */
  private setZoom(z: number | null): void {
    this.zoom = z;
    const img = this.previewImgEl;
    if (z === null) {
      this.previewEl.classList.remove("files__preview--zoomed", "files__preview--pixel");
      img.style.width = "";
      img.style.height = "";
      this.zoomEl.textContent = "Fit";
      return;
    }
    this.previewEl.classList.add("files__preview--zoomed");
    this.previewEl.classList.toggle("files__preview--pixel", z >= 2);
    img.style.width = `${Math.max(1, Math.round(img.naturalWidth * z))}px`;
    img.style.height = "auto";
    this.zoomEl.textContent = `${Math.round(z * 100)}%`;
  }

  /**
   * Step the zoom. Starting from "fit" this measures the scale the image is
   * actually rendered at, so the first zoom step continues from what's on
   * screen rather than jumping to 100%.
   */
  private zoomBy(factor: number): void {
    if (this.mode !== "image") return;
    const img = this.previewImgEl;
    if (!img.naturalWidth) return;
    const current = this.zoom ?? img.clientWidth / img.naturalWidth;
    this.setZoom(Math.min(16, Math.max(0.05, current * factor)));
  }

  private async loadFile(path: string): Promise<void> {
    if (!this.conn) return;
    if (this.dirty && !confirm("Discard unsaved changes to the current file?")) return;
    this.setStatus("Opening…");
    try {
      const file = await api.sftpRead(this.conn.id, path);
      this.clearPreview();
      this.mode = "text";
      // Reveal the editor before loading it — CodeMirror measures on the way in.
      this.applyMode();
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
    // the editor on a freshly-opened, unmodified file), and the image preview is
    // strictly view-only — never let a save path reach it.
    if (!this.conn || !this.openPath || !this.dirty || this.mode !== "text") return;
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

  /** Tear down the image preview and release the decoded bytes. */
  private clearPreview(): void {
    this.previewImgEl.removeAttribute("src");
    if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
    this.previewUrl = null;
    this.previewSize = 0;
    this.setZoom(null);
  }

  private clearEditor(): void {
    this.editor.clear();
    this.clearPreview();
    this.mode = "none";
    this.applyMode();
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
