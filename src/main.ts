import "./styles.css";
import * as api from "./api";
import type { Connection } from "./api";
import { ConnectionModal, connectionSubtitle, type SavePayload } from "./connections";
import { TerminalSession, type SessionStatus, TERMINAL_THEMES, DEFAULT_THEME } from "./terminal";
import { CommandPalette } from "./snippets";
import { FilesBrowser } from "./files";
import { DashboardPanel } from "./dashboard";
import { open, save } from "@tauri-apps/plugin-dialog";

// ---- DOM refs ---------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

const appEl = $<HTMLDivElement>("app");
const connListEl = $<HTMLUListElement>("conn-list");
const connCountEl = $<HTMLSpanElement>("conn-count");
const searchEl = $<HTMLInputElement>("search");
const tabbarEl = $<HTMLDivElement>("tabbar");
const terminalsEl = $<HTMLDivElement>("terminals");
const emptyStateEl = $<HTMLDivElement>("empty-state");

// Lock screen
const lockScreenEl = $<HTMLDivElement>("lock-screen");
const lockFormEl = $<HTMLFormElement>("lock-form");
const lockPwEl = $<HTMLInputElement>("lock-pw");
const lockPw2El = $<HTMLInputElement>("lock-pw2");
const lockSubEl = $<HTMLParagraphElement>("lock-sub");
const lockErrorEl = $<HTMLParagraphElement>("lock-error");
const lockHintEl = $<HTMLParagraphElement>("lock-hint");
const lockSubmitEl = $<HTMLButtonElement>("lock-submit");

// Settings modal
const settingsBackdropEl = $<HTMLDivElement>("settings-backdrop");
const setAutolockEl = $<HTMLInputElement>("set-autolock");
const setMsgEl = $<HTMLParagraphElement>("set-msg");
const cpCurrentEl = $<HTMLInputElement>("cp-current");
const cpNewEl = $<HTMLInputElement>("cp-new");
const cpNew2El = $<HTMLInputElement>("cp-new2");
const setFontSizeEl = $<HTMLInputElement>("set-fontsize");
const setTermThemeEl = $<HTMLSelectElement>("set-termtheme");

// ---- App state --------------------------------------------------------------

interface OpenSession {
  session: TerminalSession;
  tabEl: HTMLDivElement;
}

let connections: Connection[] = [];
const sessions = new Map<string, OpenSession>();
let activeSessionId: string | null = null;
let appUnlocked = false;
let lockMode: "create" | "unlock" = "unlock";
let autoLockMinutes = 0;
let idleTimer: number | undefined;
let favOnly = false;
let dragId: string | null = null;

function loadCollapsedGroups(): string[] {
  try {
    return JSON.parse(localStorage.getItem("vaulterm.collapsedGroups") || "[]");
  } catch {
    return [];
  }
}
const collapsedGroups = new Set<string>(loadCollapsedGroups());
let termFontSize = Number(localStorage.getItem("vaulterm.fontSize")) || 14;
let termTheme = localStorage.getItem("vaulterm.termTheme") || DEFAULT_THEME;

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

// ---- Sidebar ----------------------------------------------------------------

function connectionStatus(connectionId: string): SessionStatus | null {
  let status: SessionStatus | null = null;
  for (const { session } of sessions.values()) {
    if (session.connection.id !== connectionId) continue;
    if (session.status === "connected") return "connected";
    if (session.status === "connecting") status = "connecting";
  }
  return status;
}

function buildConnItem(conn: Connection): HTMLLIElement {
  const item = el("li", "conn-item");
  item.dataset.id = conn.id;
  item.draggable = true;

  const status = connectionStatus(conn.id);
  if (status) item.classList.add(status);
  if (conn.color) {
    item.classList.add("has-color");
    item.style.setProperty("--accent-color", conn.color);
  }

  const dot = el("span", "conn-item__dot");

  const star = el("button", `conn-item__star${conn.favorite ? " on" : ""}`, conn.favorite ? "★" : "☆");
  star.title = conn.favorite ? "Unfavorite" : "Favorite";
  star.addEventListener("click", (e) => {
    e.stopPropagation();
    void toggleFavorite(conn);
  });

  const body = el("div", "conn-item__body");
  body.append(el("div", "conn-item__name", conn.name || "(unnamed)"));
  body.append(el("div", "conn-item__sub", connectionSubtitle(conn)));

  const actions = el("div", "conn-item__actions");
  const dashBtn = el("button", "icon-btn", "📊");
  dashBtn.title = "Server status";
  dashBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    void dashboard.open(conn);
  });
  const filesBtn = el("button", "icon-btn", "📁");
  filesBtn.title = "Browse files";
  filesBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    void filesBrowser.open(conn);
  });
  const editBtn = el("button", "icon-btn", "✎");
  editBtn.title = "Edit";
  editBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    modal.openEdit(conn);
  });
  const delBtn = el("button", "icon-btn icon-btn--danger", "🗑");
  delBtn.title = "Delete";
  delBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    void removeConnection(conn);
  });
  actions.append(dashBtn, filesBtn, editBtn, delBtn);

  item.append(dot, star, body, actions);
  item.addEventListener("click", () => void openSession(conn));

  // Drag to reorder.
  item.addEventListener("dragstart", (e) => {
    dragId = conn.id;
    item.classList.add("dragging");
    e.dataTransfer?.setData("text/plain", conn.id);
  });
  item.addEventListener("dragend", () => {
    dragId = null;
    connListEl.querySelectorAll(".conn-item").forEach((x) => x.classList.remove("dragging", "drop-target"));
  });
  item.addEventListener("dragover", (e) => {
    if (dragId && dragId !== conn.id) {
      e.preventDefault();
      item.classList.add("drop-target");
    }
  });
  item.addEventListener("dragleave", () => item.classList.remove("drop-target"));
  item.addEventListener("drop", (e) => {
    e.preventDefault();
    item.classList.remove("drop-target");
    void handleReorderDrop(conn.id);
  });

  return item;
}

function renderSidebar(): void {
  const filter = searchEl.value.trim().toLowerCase();
  const shown = connections.filter((c) => {
    if (favOnly && !c.favorite) return false;
    if (!filter) return true;
    return (
      c.name.toLowerCase().includes(filter) ||
      c.host.toLowerCase().includes(filter) ||
      c.username.toLowerCase().includes(filter) ||
      (c.group ?? "").toLowerCase().includes(filter)
    );
  });

  connListEl.replaceChildren();
  updateGroupDatalist();

  if (shown.length === 0) {
    const empty = el("li", "conn-list__empty");
    empty.textContent = connections.length === 0 ? "No saved connections yet." : "No matches.";
    empty.style.cssText = "padding:16px;color:var(--text-faint);font-size:13px;text-align:center;";
    connListEl.append(empty);
  } else if (!shown.some((c) => (c.group ?? "").trim() !== "")) {
    for (const conn of shown) connListEl.append(buildConnItem(conn));
  } else {
    const groups = new Map<string, Connection[]>();
    for (const conn of shown) {
      const g = (conn.group ?? "").trim() || "Ungrouped";
      const bucket = groups.get(g) ?? [];
      bucket.push(conn);
      groups.set(g, bucket);
    }
    const names = [...groups.keys()].sort((a, b) =>
      a === "Ungrouped" ? 1 : b === "Ungrouped" ? -1 : a.localeCompare(b),
    );
    for (const name of names) {
      const collapsed = collapsedGroups.has(name);
      const header = el("li", "conn-group");
      header.append(el("span", "conn-group__caret", collapsed ? "▸" : "▾"));
      header.append(el("span", "conn-group__name", name));
      header.append(el("span", "conn-group__count", String(groups.get(name)!.length)));
      header.addEventListener("click", () => toggleGroup(name));
      connListEl.append(header);
      if (!collapsed) for (const conn of groups.get(name)!) connListEl.append(buildConnItem(conn));
    }
  }

  connCountEl.textContent = `${connections.length} connection${connections.length === 1 ? "" : "s"}`;
}

function updateGroupDatalist(): void {
  const dl = document.getElementById("group-list");
  if (!dl) return;
  const names = [...new Set(connections.map((c) => (c.group ?? "").trim()).filter(Boolean))].sort();
  dl.replaceChildren(
    ...names.map((n) => {
      const o = document.createElement("option");
      o.value = n;
      return o;
    }),
  );
}

function toggleGroup(name: string): void {
  if (collapsedGroups.has(name)) collapsedGroups.delete(name);
  else collapsedGroups.add(name);
  localStorage.setItem("vaulterm.collapsedGroups", JSON.stringify([...collapsedGroups]));
  renderSidebar();
}

async function toggleFavorite(conn: Connection): Promise<void> {
  try {
    await api.saveConnection({ ...conn, favorite: !conn.favorite }, null, null);
    connections = await api.listConnections();
    renderSidebar();
  } catch (e) {
    console.error("toggle favorite failed", e);
  }
}

async function handleReorderDrop(targetId: string): Promise<void> {
  if (!dragId || dragId === targetId) return;
  const from = connections.findIndex((c) => c.id === dragId);
  if (from < 0) return;
  const [moved] = connections.splice(from, 1);
  const to = connections.findIndex((c) => c.id === targetId);
  connections.splice(to < 0 ? connections.length : to, 0, moved);
  renderSidebar();
  try {
    await api.reorderConnections(connections.map((c) => c.id));
  } catch (e) {
    console.error("reorder failed", e);
  }
}

// ---- Sessions / tabs --------------------------------------------------------

async function openSession(conn: Connection): Promise<void> {
  const sessionId = crypto.randomUUID();
  const session = new TerminalSession(conn, sessionId, {
    fontSize: termFontSize,
    themeName: termTheme,
    onZoom: handleZoom,
  });

  const tabEl = el("div", "tab connecting");
  tabEl.dataset.sid = sessionId;
  const tabDot = el("span", "tab__dot");
  const tabLabel = el("span", "tab__label", conn.name || conn.host);
  const tabClose = el("button", "tab__close", "×");
  tabClose.title = "Close session";
  tabClose.addEventListener("click", (e) => {
    e.stopPropagation();
    closeSession(sessionId);
  });
  tabEl.append(tabDot, tabLabel, tabClose);
  tabEl.addEventListener("click", () => activateSession(sessionId));
  tabbarEl.append(tabEl);

  session.onStatusChange = (s) => {
    tabEl.classList.remove("connecting", "connected", "closed");
    tabEl.classList.add(s);
    renderSidebar();
  };

  terminalsEl.append(session.element);
  sessions.set(sessionId, { session, tabEl });

  activateSession(sessionId);
  renderSidebar();
  await session.start();
}

function activateSession(sessionId: string): void {
  activeSessionId = sessionId;

  for (const [sid, { session, tabEl }] of sessions) {
    const active = sid === sessionId;
    session.element.classList.toggle("hidden", !active);
    tabEl.classList.toggle("active", active);
    if (active) session.focus();
  }

  emptyStateEl.classList.toggle("hidden", sessions.size > 0);
}

function closeSession(sessionId: string): void {
  const open = sessions.get(sessionId);
  if (!open) return;

  open.session.dispose();
  open.tabEl.remove();
  sessions.delete(sessionId);

  if (activeSessionId === sessionId) {
    activeSessionId = null;
    const next = [...sessions.keys()].at(-1);
    if (next) activateSession(next);
    else emptyStateEl.classList.remove("hidden");
  }
  renderSidebar();
}

// ---- Connection CRUD --------------------------------------------------------

const modal = new ConnectionModal(async ({ conn, secret, keyText }: SavePayload) => {
  await api.saveConnection(conn, secret, keyText);
  connections = await api.listConnections();
  renderSidebar();
});

// Inserts a snippet's command into the active, connected terminal. Returns
// false (so the palette can warn) when there's nowhere to send it.
const palette = new CommandPalette((command) => {
  if (!activeSessionId) return false;
  const open = sessions.get(activeSessionId);
  if (!open || open.session.status !== "connected") return false;
  open.session.sendText(command);
  return true;
});

const filesBrowser = new FilesBrowser();
const dashboard = new DashboardPanel();

async function removeConnection(conn: Connection): Promise<void> {
  const ok = confirm(`Delete "${conn.name || connectionSubtitle(conn)}"?\nThis also removes its saved password.`);
  if (!ok) return;
  await api.deleteConnection(conn.id);
  connections = await api.listConnections();
  renderSidebar();
}

// ---- Lock screen / vault ----------------------------------------------------

function showLock(mode: "create" | "unlock"): void {
  lockMode = mode;
  appUnlocked = false;
  resetIdleTimer();
  appEl.classList.add("hidden");
  lockScreenEl.classList.remove("hidden");
  lockErrorEl.classList.add("hidden");
  lockPwEl.value = "";
  lockPw2El.value = "";
  if (mode === "create") {
    lockSubEl.textContent = "Create a master password";
    lockPw2El.classList.remove("hidden");
    lockSubmitEl.textContent = "Create vault";
    lockHintEl.textContent =
      "This password encrypts everything you save — connections, passwords, and keys. There is no recovery: if you forget it, the data can't be decrypted.";
  } else {
    lockSubEl.textContent = "Unlock your vault";
    lockPw2El.classList.add("hidden");
    lockSubmitEl.textContent = "Unlock";
    lockHintEl.textContent = "";
  }
  lockPwEl.focus();
}

function showLockError(msg: string): void {
  lockErrorEl.textContent = msg.replace(/^.*Error:\s*/, "");
  lockErrorEl.classList.remove("hidden");
}

async function enterApp(): Promise<void> {
  appUnlocked = true;
  lockScreenEl.classList.add("hidden");
  appEl.classList.remove("hidden");
  connections = await api.listConnections();
  renderSidebar();
  try {
    const s = await api.getSettings();
    applyAutoLock(s.autoLockMinutes);
  } catch {
    applyAutoLock(0);
  }
}

async function handleLockSubmit(e: SubmitEvent): Promise<void> {
  e.preventDefault();
  lockErrorEl.classList.add("hidden");
  const pw = lockPwEl.value;
  try {
    if (lockMode === "create") {
      if (pw.length < 8) return showLockError("Use at least 8 characters.");
      if (pw !== lockPw2El.value) return showLockError("Passwords don't match.");
      await api.vaultCreate(pw);
    } else {
      await api.vaultUnlock(pw);
    }
    await enterApp();
  } catch (err) {
    showLockError(String(err));
    lockPwEl.select();
  }
}

async function lockApp(): Promise<void> {
  // Tear down overlays + live sessions before the key is wiped.
  filesBrowser.hideForLock();
  dashboard.hideForLock();
  for (const sid of [...sessions.keys()]) closeSession(sid);
  try {
    await api.vaultLock();
  } catch {
    /* ignore */
  }
  connections = [];
  renderSidebar();
  showLock("unlock");
}

// ---- Auto-lock + settings ---------------------------------------------------

function resetIdleTimer(): void {
  if (idleTimer !== undefined) window.clearTimeout(idleTimer);
  idleTimer = undefined;
  if (appUnlocked && autoLockMinutes > 0) {
    idleTimer = window.setTimeout(() => void lockApp(), autoLockMinutes * 60_000);
  }
}

function applyAutoLock(minutes: number): void {
  autoLockMinutes = Number.isFinite(minutes) && minutes > 0 ? Math.floor(minutes) : 0;
  resetIdleTimer();
}

function handleZoom(delta: number | "reset"): void {
  termFontSize = delta === "reset" ? 14 : Math.min(30, Math.max(8, termFontSize + delta));
  localStorage.setItem("vaulterm.fontSize", String(termFontSize));
  applyTermPrefs();
  setFontSizeEl.value = String(termFontSize);
}

function applyTermPrefs(): void {
  for (const { session } of sessions.values()) {
    session.setFontSize(termFontSize);
    session.setTheme(termTheme);
  }
}

function setSettingsMsg(msg: string, ok: boolean): void {
  setMsgEl.textContent = msg;
  setMsgEl.classList.remove("hidden");
  setMsgEl.classList.toggle("ok", ok);
}

function openSettings(): void {
  setMsgEl.classList.add("hidden");
  setAutolockEl.value = String(autoLockMinutes);
  void api
    .getSettings()
    .then((s) => {
      setAutolockEl.value = String(s.autoLockMinutes);
    })
    .catch(() => {});
  cpCurrentEl.value = "";
  cpNewEl.value = "";
  cpNew2El.value = "";
  setFontSizeEl.value = String(termFontSize);
  setTermThemeEl.value = termTheme;
  settingsBackdropEl.classList.remove("hidden");
}

function closeSettings(): void {
  settingsBackdropEl.classList.add("hidden");
  cpCurrentEl.value = "";
  cpNewEl.value = "";
  cpNew2El.value = "";
}

async function handleSaveSettings(): Promise<void> {
  const minutes = Number(setAutolockEl.value);
  if (!Number.isInteger(minutes) || minutes < 0) {
    return setSettingsMsg("Minutes must be 0 or more.", false);
  }
  try {
    await api.saveSettings({ autoLockMinutes: minutes });
    applyAutoLock(minutes);
    setSettingsMsg(minutes === 0 ? "Auto-lock disabled." : `Will lock after ${minutes} min idle.`, true);
  } catch (e) {
    setSettingsMsg(errText(e), false);
  }
}

async function handleChangePassword(): Promise<void> {
  const current = cpCurrentEl.value;
  const next = cpNewEl.value;
  if (!current) return setSettingsMsg("Enter your current password.", false);
  if (next.length < 8) return setSettingsMsg("New password must be at least 8 characters.", false);
  if (next !== cpNew2El.value) return setSettingsMsg("New passwords don't match.", false);
  try {
    await api.vaultChangePassword(current, next);
    cpCurrentEl.value = "";
    cpNewEl.value = "";
    cpNew2El.value = "";
    setSettingsMsg("Master password changed.", true);
  } catch (e) {
    setSettingsMsg(errText(e), false);
  }
}

async function handleExportVault(): Promise<void> {
  try {
    const dest = await save({ defaultPath: "vaulterm-vault-backup.json", title: "Export vault backup" });
    if (!dest) return;
    await api.vaultExport(dest);
    setSettingsMsg(`Backup saved to ${dest}`, true);
  } catch (e) {
    setSettingsMsg(errText(e), false);
  }
}

async function handleImportVault(): Promise<void> {
  const ok = confirm(
    "Restore a vault backup?\n\nThis REPLACES your current vault and everything in it. " +
      "You'll need the backup's master password to unlock. Continue?",
  );
  if (!ok) return;
  try {
    const src = await open({ multiple: false, directory: false, title: "Choose a vault backup (.json)" });
    if (!src || Array.isArray(src)) return;
    await api.vaultImport(src);
    closeSettings();
    await lockApp(); // backend re-locked — unlock with the imported password
  } catch (e) {
    setSettingsMsg(errText(e), false);
  }
}

function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  return String(e);
}

// ---- Wiring -----------------------------------------------------------------

function bindUi(): void {
  lockFormEl.addEventListener("submit", (e) => void handleLockSubmit(e));
  $("btn-new").addEventListener("click", () => modal.openNew());
  $("btn-new-2").addEventListener("click", () => modal.openNew());
  $("btn-cmds").addEventListener("click", () => palette.toggle());
  $("btn-lock").addEventListener("click", () => void lockApp());
  $("btn-settings").addEventListener("click", openSettings);
  $("set-save").addEventListener("click", () => void handleSaveSettings());
  $("set-close").addEventListener("click", closeSettings);
  $("cp-change").addEventListener("click", () => void handleChangePassword());
  $("vault-export").addEventListener("click", () => void handleExportVault());
  $("vault-import").addEventListener("click", () => void handleImportVault());
  setTermThemeEl.replaceChildren(
    ...Object.keys(TERMINAL_THEMES).map((n) => {
      const o = document.createElement("option");
      o.value = n;
      o.textContent = n;
      return o;
    }),
  );
  setFontSizeEl.addEventListener("change", () => {
    const n = Number(setFontSizeEl.value);
    if (Number.isInteger(n) && n >= 8 && n <= 30) {
      termFontSize = n;
      localStorage.setItem("vaulterm.fontSize", String(n));
      applyTermPrefs();
    }
  });
  setTermThemeEl.addEventListener("change", () => {
    termTheme = setTermThemeEl.value;
    localStorage.setItem("vaulterm.termTheme", termTheme);
    applyTermPrefs();
  });
  settingsBackdropEl.addEventListener("mousedown", (e) => {
    if (e.target === settingsBackdropEl) closeSettings();
  });
  searchEl.addEventListener("input", renderSidebar);
  $("fav-filter").addEventListener("click", () => {
    favOnly = !favOnly;
    const b = $("fav-filter");
    b.textContent = favOnly ? "★" : "☆";
    b.classList.toggle("active", favOnly);
    renderSidebar();
  });

  // Any user activity resets the idle auto-lock timer.
  const activity = (): void => resetIdleTimer();
  (["mousemove", "mousedown", "keydown", "wheel", "touchstart"] as const).forEach((ev) =>
    document.addEventListener(ev, activity, { passive: true }),
  );

  document.addEventListener("keydown", (e) => {
    if (!appUnlocked) return; // shortcuts are inert while the vault is locked
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "l") {
      e.preventDefault();
      void lockApp();
    } else if (mod && e.key.toLowerCase() === "k") {
      e.preventDefault();
      palette.toggle();
    } else if (mod && e.key.toLowerCase() === "n") {
      e.preventDefault();
      modal.openNew();
    } else if (mod && e.key.toLowerCase() === "w" && activeSessionId) {
      e.preventDefault();
      closeSession(activeSessionId);
    }
  });

  // Backend told us a session ended (remote closed / dropped).
  void api.onSessionClosed((sessionId) => {
    sessions.get(sessionId)?.session.markClosed();
    renderSidebar();
  });
}

async function init(): Promise<void> {
  bindUi();
  try {
    const status = await api.vaultStatus();
    if (status.unlocked) await enterApp();
    else showLock(status.exists ? "unlock" : "create");
  } catch (e) {
    console.error("vault status check failed", e);
    showLock("unlock");
  }
}

void init();
