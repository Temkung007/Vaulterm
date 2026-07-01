import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import type { AuthType, Connection } from "./api";

export function connectionSubtitle(c: Connection): string {
  return `${c.username || "user"}@${c.host || "host"}:${c.port}`;
}

/** Preset accent colors ("" = none). */
export const CONNECTION_COLORS = ["", "#f85149", "#d29922", "#3fb950", "#2f81f7", "#a371f7", "#db61a2"];

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

/** What the form produces on save. A `null` field => keep the existing value. */
export interface SavePayload {
  conn: Connection;
  /** Password (password auth) or key passphrase (key / key_text auth). */
  secret: string | null;
  /** Pasted private-key text (key_text auth only). */
  keyText: string | null;
}

/**
 * Wraps the add/edit modal. Call `openNew()` / `openEdit()` to show it; the
 * `onSave` callback receives the validated connection + secret.
 */
export class ConnectionModal {
  private backdrop = $<HTMLDivElement>("modal-backdrop");
  private form = $<HTMLFormElement>("conn-form");
  private title = $<HTMLHeadingElement>("modal-title");
  private error = $<HTMLParagraphElement>("form-error");

  private fId = $<HTMLInputElement>("f-id");
  private fName = $<HTMLInputElement>("f-name");
  private fHost = $<HTMLInputElement>("f-host");
  private fPort = $<HTMLInputElement>("f-port");
  private fUser = $<HTMLInputElement>("f-user");
  private fAuth = $<HTMLSelectElement>("f-auth");
  private fPassword = $<HTMLInputElement>("f-password");
  private fKeyPath = $<HTMLInputElement>("f-keypath");
  private fKeyText = $<HTMLTextAreaElement>("f-keytext");
  private fPassphrase = $<HTMLInputElement>("f-passphrase");
  private fGroup = $<HTMLInputElement>("f-group");
  private fStartup = $<HTMLTextAreaElement>("f-startup");
  private fColorsEl = $<HTMLDivElement>("f-colors");
  private fJump = $<HTMLSelectElement>("f-jump");

  // Captured here so we can restore it after edit mode swaps the placeholder.
  private keyPlaceholder = this.fKeyText.placeholder;
  private editing = false;
  private selectedColor = "";
  private currentFavorite = false;
  private allConnections: Connection[] = [];

  /** Provide the full connection list so the jump-host dropdown can be built. */
  setConnections(list: Connection[]): void {
    this.allConnections = list;
  }

  private populateJumpOptions(currentId: string, selected: string): void {
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "— None (direct) —";
    const opts = [none];
    for (const c of this.allConnections) {
      if (c.id === currentId) continue;
      const o = document.createElement("option");
      o.value = c.id;
      o.textContent = `${c.name || c.host} (${connectionSubtitle(c)})`;
      opts.push(o);
    }
    this.fJump.replaceChildren(...opts);
    this.fJump.value = selected;
  }

  constructor(private onSave: (payload: SavePayload) => void | Promise<void>) {
    this.fAuth.addEventListener("change", () => this.syncAuthFields());
    $("btn-cancel").addEventListener("click", () => this.close());
    this.backdrop.addEventListener("click", (e) => {
      if (e.target === this.backdrop) this.close();
    });
    $("btn-browse-key").addEventListener("click", () => this.browseKey());
    this.form.addEventListener("submit", (e) => this.submit(e));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.backdrop.classList.contains("hidden")) this.close();
    });
    this.renderColorSwatches();
  }

  private renderColorSwatches(): void {
    this.fColorsEl.replaceChildren();
    for (const color of CONNECTION_COLORS) {
      const sw = document.createElement("button");
      sw.type = "button";
      sw.className = "color-swatch";
      sw.dataset.color = color;
      if (color) {
        sw.style.background = color;
      } else {
        sw.classList.add("color-swatch--none");
        sw.textContent = "∅";
      }
      sw.title = color || "No color";
      sw.addEventListener("click", () => {
        this.selectedColor = color;
        this.updateColorSelection();
      });
      this.fColorsEl.append(sw);
    }
  }

  private updateColorSelection(): void {
    this.fColorsEl.querySelectorAll<HTMLElement>(".color-swatch").forEach((sw) => {
      sw.classList.toggle("selected", (sw.dataset.color || "") === this.selectedColor);
    });
  }

  openNew(): void {
    this.editing = false;
    this.title.textContent = "New Connection";
    this.form.reset();
    this.fId.value = "";
    this.fPort.value = "22";
    this.fAuth.value = "password";
    this.fPassword.placeholder = "••••••••  (stored in OS keychain)";
    this.fKeyText.placeholder = this.keyPlaceholder;
    this.selectedColor = "";
    this.currentFavorite = false;
    this.updateColorSelection();
    this.populateJumpOptions("", "");
    this.syncAuthFields();
    this.show();
    this.fName.focus();
  }

  openEdit(c: Connection): void {
    this.editing = true;
    this.title.textContent = "Edit Connection";
    this.hideError();
    this.fId.value = c.id;
    this.fName.value = c.name;
    this.fHost.value = c.host;
    this.fPort.value = String(c.port);
    this.fUser.value = c.username;
    this.fAuth.value = c.authType;
    this.fKeyPath.value = c.keyPath ?? "";
    // Don't surface stored secrets; leaving a field blank keeps them.
    this.fPassword.value = "";
    this.fPassphrase.value = "";
    this.fKeyText.value = "";
    this.fPassword.placeholder = "leave blank to keep saved password";
    this.fKeyText.placeholder = "leave blank to keep the saved key";
    this.fGroup.value = c.group ?? "";
    this.fStartup.value = c.startupCommands ?? "";
    this.selectedColor = c.color ?? "";
    this.currentFavorite = c.favorite ?? false;
    this.updateColorSelection();
    this.populateJumpOptions(c.id, c.jump ?? "");
    this.syncAuthFields();
    this.show();
    this.fName.focus();
  }

  close(): void {
    this.backdrop.classList.add("hidden");
    // Don't leave secrets sitting in the DOM after the dialog closes.
    this.fPassword.value = "";
    this.fPassphrase.value = "";
    this.fKeyText.value = "";
  }

  private show(): void {
    this.hideError();
    this.backdrop.classList.remove("hidden");
  }

  private syncAuthFields(): void {
    const auth = this.fAuth.value as AuthType;
    const cls =
      auth === "password" ? "auth-password" : auth === "key" ? "auth-key" : "auth-keytext";
    // Show each field whose auth class matches the current method. The
    // passphrase field carries both auth-key and auth-keytext, so it shows for
    // either key method.
    document.querySelectorAll<HTMLElement>(".auth-field").forEach((el) => {
      el.classList.toggle("show", el.classList.contains(cls));
    });
  }

  private async browseKey(): Promise<void> {
    const picked = await openFileDialog({
      multiple: false,
      directory: false,
      title: "Select private key file",
    });
    if (typeof picked === "string") this.fKeyPath.value = picked;
  }

  private async submit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    this.hideError();

    const auth = this.fAuth.value as AuthType;
    const port = Number(this.fPort.value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return this.showError("Port must be between 1 and 65535.");
    }
    if (auth === "key" && !this.fKeyPath.value.trim()) {
      return this.showError("Please choose a private key file.");
    }

    // Collect & validate a pasted private key (key_text auth). Blank on edit
    // keeps the saved key.
    let keyText: string | null = null;
    if (auth === "key_text") {
      const kt = this.fKeyText.value.trim();
      if (kt) {
        if (!/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(kt)) {
          return this.showError(
            "That doesn't look like a private key — expected a -----BEGIN … PRIVATE KEY----- block.",
          );
        }
        keyText = kt;
      } else if (!this.editing) {
        return this.showError("Please paste your private key.");
      }
    }

    const conn: Connection = {
      id: this.fId.value, // empty => backend assigns a new id
      name: this.fName.value.trim(),
      host: this.fHost.value.trim(),
      port,
      username: this.fUser.value.trim(),
      authType: auth,
      keyPath: auth === "key" ? this.fKeyPath.value.trim() : null,
      jump: this.fJump.value || null,
      group: this.fGroup.value.trim() || null,
      favorite: this.currentFavorite,
      color: this.selectedColor || null,
      startupCommands: this.fStartup.value.trim() || null,
    };

    // Determine the secret. Blank on edit => keep existing (null).
    let secret: string | null;
    if (auth === "password") {
      secret = this.fPassword.value !== "" ? this.fPassword.value : this.editing ? null : "";
    } else {
      const pass = this.fPassphrase.value;
      secret = pass !== "" ? pass : this.editing ? null : "";
    }

    try {
      await this.onSave({ conn, secret, keyText });
      this.close();
    } catch (err) {
      this.showError(String(err));
    }
  }

  private showError(msg: string): void {
    this.error.textContent = msg;
    this.error.classList.remove("hidden");
  }
  private hideError(): void {
    this.error.classList.add("hidden");
  }
}
