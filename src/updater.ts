import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdateStatus =
  | { kind: "checking" }
  | { kind: "uptodate" }
  | { kind: "downloading"; pct?: number }
  | { kind: "installed" }
  | { kind: "error"; message: string };

function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  return String(e);
}

export type { Update };

/** Query GitHub Releases for a newer signed build. Returns the update handle,
 *  or null if already current. Throws if the check itself fails (offline etc). */
export async function fetchUpdate(): Promise<Update | null> {
  return await check();
}

/** Download + install the given update, then relaunch. Reports progress. */
export async function installUpdate(
  update: Update,
  onStatus: (s: UpdateStatus) => void,
): Promise<void> {
  try {
    let total = 0;
    let downloaded = 0;
    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          total = event.data.contentLength ?? 0;
          onStatus({ kind: "downloading", pct: 0 });
          break;
        case "Progress":
          downloaded += event.data.chunkLength;
          onStatus({
            kind: "downloading",
            pct: total ? Math.min(100, Math.round((downloaded / total) * 100)) : undefined,
          });
          break;
        case "Finished":
          onStatus({ kind: "installed" });
          break;
      }
    });
    onStatus({ kind: "installed" });
    await relaunch();
  } catch (e) {
    onStatus({ kind: "error", message: errText(e) });
  }
}

/**
 * Manual "Check for updates": check, confirm with the user, then install.
 * Reports progress via `onStatus`.
 */
export async function checkForUpdates(onStatus: (s: UpdateStatus) => void): Promise<void> {
  onStatus({ kind: "checking" });

  let update: Update | null;
  try {
    update = await fetchUpdate();
  } catch (e) {
    onStatus({ kind: "error", message: errText(e) });
    return;
  }

  if (!update) {
    onStatus({ kind: "uptodate" });
    return;
  }

  const ok = confirm(
    `A new version of Vaulterm is available.\n\n` +
      `New: v${update.version}\nCurrent: v${update.currentVersion}\n\n` +
      (update.body ? `${update.body}\n\n` : "") +
      `Download and install now? The app will relaunch when it finishes.`,
  );
  if (!ok) {
    onStatus({ kind: "uptodate" });
    return;
  }

  await installUpdate(update, onStatus);
}
