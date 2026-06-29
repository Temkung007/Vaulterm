import "./styles.css";
import * as api from "./api";
import type { Connection } from "./api";
import { ConnectionModal, connectionSubtitle, type SavePayload } from "./connections";
import { TerminalSession, type SessionStatus } from "./terminal";
import { CommandPalette } from "./snippets";
import { FilesBrowser } from "./files";

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

function renderSidebar(): void {
  const filter = searchEl.value.trim().toLowerCase();
  const shown = connections.filter(
    (c) =>
      !filter ||
      c.name.toLowerCase().includes(filter) ||
      c.host.toLowerCase().includes(filter) ||
      c.username.toLowerCase().includes(filter),
  );

  connListEl.replaceChildren();

  if (shown.length === 0) {
    const empty = el("li", "conn-list__empty");
    empty.textContent = connections.length === 0 ? "No saved connections yet." : "No matches.";
    empty.style.cssText = "padding:16px;color:var(--text-faint);font-size:13px;text-align:center;";
    connListEl.append(empty);
  }

  for (const conn of shown) {
    const item = el("li", "conn-item");
    item.dataset.id = conn.id;

    const status = connectionStatus(conn.id);
    if (status) item.classList.add(status);

    const dot = el("span", "conn-item__dot");
    const body = el("div", "conn-item__body");
    body.append(el("div", "conn-item__name", conn.name || "(unnamed)"));
    body.append(el("div", "conn-item__sub", connectionSubtitle(conn)));

    const actions = el("div", "conn-item__actions");
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
    actions.append(filesBtn, editBtn, delBtn);

    item.append(dot, body, actions);
    item.addEventListener("click", () => void openSession(conn));
    connListEl.append(item);
  }

  connCountEl.textContent = `${connections.length} connection${connections.length === 1 ? "" : "s"}`;
}

// ---- Sessions / tabs --------------------------------------------------------

async function openSession(conn: Connection): Promise<void> {
  const sessionId = crypto.randomUUID();
  const session = new TerminalSession(conn, sessionId);

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
  // Tear down the file browser + live sessions before the key is wiped.
  filesBrowser.hideForLock();
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
  settingsBackdropEl.addEventListener("mousedown", (e) => {
    if (e.target === settingsBackdropEl) closeSettings();
  });
  searchEl.addEventListener("input", renderSidebar);

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
