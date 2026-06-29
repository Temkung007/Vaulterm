import * as api from "./api";
import type { Snippet } from "./api";

export interface BuiltinSnippet extends Snippet {
  builtin: true;
  danger?: boolean;
}
type AnySnippet = (Snippet & { builtin?: false; danger?: boolean }) | BuiltinSnippet;

/** Built-in Ubuntu command pack. `{name}` tokens are prompted before insert. */
export const BUILTIN_SNIPPETS: BuiltinSnippet[] = [
  // System
  b("Ubuntu version", "lsb_release -a", "System"),
  b("Kernel & architecture", "uname -a", "System"),
  b("Uptime & load", "uptime", "System"),
  b("Memory usage", "free -h", "System"),
  b("Disk usage (mounts)", "df -h", "System"),
  b("Block devices", "lsblk", "System"),
  b("Top processes (interactive)", "htop", "System"),
  b("CPU info", "lscpu", "System"),
  b("Who am I", "whoami && id", "System"),
  b("Reboot", "sudo reboot", "System", true),
  b("Shutdown now", "sudo shutdown -h now", "System", true),

  // Packages (apt)
  b("Refresh package lists", "sudo apt update", "Packages"),
  b("Update & upgrade all", "sudo apt update && sudo apt upgrade -y", "Packages"),
  b("Install a package", "sudo apt install -y {package}", "Packages"),
  b("Remove a package", "sudo apt remove -y {package}", "Packages", true),
  b("Search installed packages", "apt list --installed 2>/dev/null | grep -i {name}", "Packages"),
  b("Autoremove unused", "sudo apt autoremove -y", "Packages"),

  // Services (systemd)
  b("Service status", "systemctl status {service}", "Services"),
  b("Restart service", "sudo systemctl restart {service}", "Services"),
  b("Start service", "sudo systemctl start {service}", "Services"),
  b("Stop service", "sudo systemctl stop {service}", "Services", true),
  b("Enable at boot", "sudo systemctl enable {service}", "Services"),
  b("List running services", "systemctl list-units --type=service --state=running --no-pager", "Services"),

  // Network
  b("IP addresses", "ip -br a", "Network"),
  b("Listening ports", "sudo ss -tulpn", "Network"),
  b("Which process uses a port", "sudo ss -tulpn | grep :{port}", "Network"),
  b("Ping a host", "ping -c 4 {host}", "Network"),
  b("HTTP headers", "curl -I {url}", "Network"),
  b("Firewall status", "sudo ufw status verbose", "Network"),
  b("Open a port (ufw)", "sudo ufw allow {port}", "Network", true),

  // Logs
  b("Service logs (last 100)", "sudo journalctl -u {service} -n 100 --no-pager", "Logs"),
  b("Recent system errors", "sudo journalctl -p err -xb --no-pager", "Logs"),
  b("Follow syslog", "sudo tail -f /var/log/syslog", "Logs"),
  b("Kernel ring buffer", "dmesg | tail -n 50", "Logs"),

  // Disk / files
  b("Folder size", "du -sh {path}", "Disk"),
  b("List files (detailed)", "ls -lah {path}", "Disk"),
  b("Biggest dirs under /", "sudo du -h --max-depth=1 / 2>/dev/null | sort -hr | head", "Disk"),
  b("Find a file by name", "sudo find / -name '{name}' 2>/dev/null", "Disk"),

  // Docker
  b("Running containers", "docker ps", "Docker"),
  b("All containers", "docker ps -a", "Docker"),
  b("Container logs (follow)", "docker logs -f {container}", "Docker"),
  b("Compose up (detached)", "docker compose up -d", "Docker"),
  b("Prune unused images", "docker image prune -a -f", "Docker", true),
];

function b(label: string, command: string, category: string, danger = false): BuiltinSnippet {
  return { id: `builtin:${slug(label)}`, label, command, category, builtin: true, danger };
}
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

const CATEGORY_ORDER = ["System", "Packages", "Services", "Network", "Logs", "Disk", "Docker", "Custom"];

/** Unique `{name}` placeholders in first-seen order. */
export function placeholders(command: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(/\{([a-zA-Z0-9_]+)\}/g)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}
function fill(command: string, values: Record<string, string>): string {
  return command.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, k) => values[k] ?? `{${k}}`);
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
 * The ⚡ command palette. Built-in + custom snippets, fuzzy-ish search,
 * keyboard nav, placeholder prompts, and inline custom-snippet management.
 * Selecting a snippet INSERTS it into the active terminal (no auto-run).
 */
export class CommandPalette {
  private backdrop = document.getElementById("palette-backdrop") as HTMLDivElement;
  private root = document.getElementById("palette") as HTMLDivElement;

  private custom: Snippet[] = [];
  private filter = "";
  private filtered: AnySnippet[] = [];
  private selected = 0;

  private listEl?: HTMLUListElement;
  private noteEl?: HTMLDivElement;

  /** `onInsert` returns false if there is no active connected terminal. */
  constructor(private onInsert: (command: string) => boolean) {
    this.backdrop.addEventListener("mousedown", (e) => {
      if (e.target === this.backdrop) this.close();
    });
  }

  get isOpen(): boolean {
    return !this.backdrop.classList.contains("hidden");
  }

  async open(): Promise<void> {
    try {
      this.custom = await api.listSnippets();
    } catch {
      this.custom = [];
    }
    this.filter = "";
    this.selected = 0;
    this.backdrop.classList.remove("hidden");
    this.showList();
  }

  close(): void {
    this.backdrop.classList.add("hidden");
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else void this.open();
  }

  private allSnippets(): AnySnippet[] {
    const custom: AnySnippet[] = this.custom.map((s) => ({
      ...s,
      category: s.category || "Custom",
      builtin: false,
    }));
    return [...BUILTIN_SNIPPETS, ...custom];
  }

  // ---- List view ----
  private showList(): void {
    this.root.replaceChildren();

    const search = el("input", "palette__search");
    search.type = "text";
    search.placeholder = "Search Ubuntu commands…   (↑↓ move · ↵ insert · esc close)";
    search.value = this.filter;
    search.spellcheck = false;
    search.addEventListener("input", () => {
      this.filter = search.value;
      this.selected = 0;
      this.renderItems();
    });
    search.addEventListener("keydown", (e) => this.onSearchKey(e));

    const list = el("ul", "palette__list");
    this.listEl = list;

    const note = el("div", "palette__note hidden");
    this.noteEl = note;

    const footer = el("div", "palette__footer");
    const hint = el("span", "palette__hint", "Inserts into the terminal — press Enter there to run");
    const newBtn = el("button", "btn btn--ghost", "＋ New snippet");
    newBtn.addEventListener("click", () => this.showNewForm());
    footer.append(hint, newBtn);

    this.root.append(search, note, list, footer);
    this.renderItems();
    search.focus();
  }

  private renderItems(): void {
    if (!this.listEl) return;
    const f = this.filter.trim().toLowerCase();
    const items = this.allSnippets().filter(
      (s) =>
        !f ||
        s.label.toLowerCase().includes(f) ||
        s.command.toLowerCase().includes(f) ||
        s.category.toLowerCase().includes(f),
    );
    // Stable group order.
    items.sort((a, b) => {
      const ai = CATEGORY_ORDER.indexOf(a.category);
      const bi = CATEGORY_ORDER.indexOf(b.category);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
    this.filtered = items;
    if (this.selected >= items.length) this.selected = Math.max(0, items.length - 1);

    this.listEl.replaceChildren();
    if (items.length === 0) {
      const empty = el("li", "palette__empty", "No matching commands.");
      this.listEl.append(empty);
      return;
    }

    let lastCat = "";
    items.forEach((s, i) => {
      if (s.category !== lastCat) {
        lastCat = s.category;
        this.listEl!.append(el("li", "palette__cat", s.category));
      }
      const li = el("li", "palette__item");
      li.dataset.index = String(i);
      if (i === this.selected) li.classList.add("selected");

      const main = el("div", "palette__item-main");
      main.append(el("span", "palette__item-label", s.label));
      const cmd = el("code", `palette__item-cmd${s.danger ? " danger" : ""}`, s.command);
      main.append(cmd);
      li.append(main);

      if (!s.builtin) {
        const del = el("button", "icon-btn icon-btn--danger", "🗑");
        del.title = "Delete snippet";
        del.addEventListener("mousedown", (e) => {
          e.preventDefault();
          e.stopPropagation();
          void this.deleteCustom(s.id);
        });
        li.append(del);
      }

      li.addEventListener("mousemove", () => this.setSelected(i));
      li.addEventListener("click", () => this.activate(s));
      this.listEl!.append(li);
    });
    this.scrollSelectedIntoView();
  }

  private setSelected(i: number): void {
    this.selected = i;
    this.listEl?.querySelectorAll(".palette__item").forEach((node) => {
      const el = node as HTMLElement;
      el.classList.toggle("selected", Number(el.dataset.index) === i);
    });
  }

  private scrollSelectedIntoView(): void {
    this.listEl
      ?.querySelector(`.palette__item[data-index="${this.selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }

  private onSearchKey(e: KeyboardEvent): void {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.setSelected(Math.min(this.filtered.length - 1, this.selected + 1));
      this.scrollSelectedIntoView();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.setSelected(Math.max(0, this.selected - 1));
      this.scrollSelectedIntoView();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const s = this.filtered[this.selected];
      if (s) this.activate(s);
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.close();
    }
  }

  // ---- Activate / insert ----
  private activate(s: AnySnippet): void {
    const names = placeholders(s.command);
    if (names.length > 0) this.showFillForm(s, names);
    else this.doInsert(s.command);
  }

  private doInsert(command: string): void {
    if (this.onInsert(command)) this.close();
    else this.showNote("Open and connect a session first, then pick a command.");
  }

  private showNote(msg: string): void {
    if (!this.noteEl) return;
    this.noteEl.textContent = msg;
    this.noteEl.classList.remove("hidden");
  }

  // ---- Placeholder fill view ----
  private showFillForm(s: AnySnippet, names: string[]): void {
    this.root.replaceChildren();
    this.root.append(el("div", "palette__title", `Fill in: ${s.label}`));
    this.root.append(el("code", "palette__preview", s.command));

    const inputs: Record<string, HTMLInputElement> = {};
    const form = el("form", "form palette__form");
    for (const name of names) {
      const row = el("label", "form__row");
      row.append(el("span", undefined, name));
      const inp = el("input", undefined) as HTMLInputElement;
      inp.type = "text";
      inp.autocomplete = "off";
      inp.placeholder = name;
      inputs[name] = inp;
      row.append(inp);
      form.append(row);
    }

    const actions = el("div", "form__actions");
    const cancel = el("button", "btn btn--ghost", "Back");
    cancel.type = "button";
    cancel.addEventListener("click", () => this.showList());
    const insert = el("button", "btn btn--primary", "Insert");
    insert.type = "submit";
    actions.append(cancel, insert);
    form.append(actions);

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const values: Record<string, string> = {};
      for (const name of names) {
        const v = inputs[name].value.trim();
        if (!v) {
          inputs[name].focus();
          return;
        }
        values[name] = v;
      }
      this.doInsert(fill(s.command, values));
    });

    this.root.append(form);
    names.length && inputs[names[0]].focus();
  }

  // ---- New custom snippet view ----
  private showNewForm(): void {
    this.root.replaceChildren();
    this.root.append(el("div", "palette__title", "New snippet"));

    const form = el("form", "form palette__form");
    const labelRow = el("label", "form__row");
    labelRow.append(el("span", undefined, "Label"));
    const labelInp = el("input") as HTMLInputElement;
    labelInp.placeholder = "Restart nginx";
    labelRow.append(labelInp);

    const catRow = el("label", "form__row");
    catRow.append(el("span", undefined, "Category"));
    const catInp = el("input") as HTMLInputElement;
    catInp.placeholder = "Custom";
    catRow.append(catInp);

    const cmdRow = el("label", "form__row");
    cmdRow.append(el("span", undefined, "Command  (use {name} for prompts)"));
    const cmdInp = el("textarea", "key-textarea") as HTMLTextAreaElement;
    cmdInp.rows = 3;
    cmdInp.placeholder = "sudo systemctl restart {service}";
    cmdInp.spellcheck = false;
    cmdRow.append(cmdInp);

    const err = el("p", "form__error hidden");

    const actions = el("div", "form__actions");
    const cancel = el("button", "btn btn--ghost", "Back");
    cancel.type = "button";
    cancel.addEventListener("click", () => this.showList());
    const save = el("button", "btn btn--primary", "Save");
    save.type = "submit";
    actions.append(cancel, save);

    form.append(labelRow, catRow, cmdRow, err, actions);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const label = labelInp.value.trim();
      const command = cmdInp.value.trim();
      if (!label || !command) {
        err.textContent = "Label and command are required.";
        err.classList.remove("hidden");
        return;
      }
      try {
        await api.saveSnippet({ id: "", label, command, category: catInp.value.trim() || "Custom" });
        this.custom = await api.listSnippets();
        this.showList();
      } catch (ex) {
        err.textContent = String(ex);
        err.classList.remove("hidden");
      }
    });

    this.root.append(form);
    labelInp.focus();
  }

  private async deleteCustom(id: string): Promise<void> {
    if (!confirm("Delete this snippet?")) return;
    await api.deleteSnippet(id);
    this.custom = await api.listSnippets();
    this.renderItems();
  }
}
