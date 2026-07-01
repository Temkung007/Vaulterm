import * as api from "./api";
import type { Connection } from "./api";

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

// One combined, read-only command. Each value is echoed after an @@KEY@@ marker
// so the output parses into a map regardless of locale/format.
const DASHBOARD_CMD = [
  'echo "@@OS@@"; (lsb_release -ds 2>/dev/null || (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") || echo unknown)',
  'echo "@@KERNEL@@"; uname -sr',
  'echo "@@HOST@@"; hostname',
  'echo "@@UPTIME@@"; (uptime -p 2>/dev/null || uptime)',
  'echo "@@LOAD@@"; (cut -d" " -f1-3 /proc/loadavg 2>/dev/null || echo n/a)',
  'echo "@@CPU@@"; (nproc 2>/dev/null || echo "?")',
  "echo \"@@MEM@@\"; (free -m 2>/dev/null | awk '/Mem:/{printf \"%d / %d MB (%.0f%%)\", $3, $2, $3/$2*100}' || echo n/a)",
  "echo \"@@DISK@@\"; (df -h / 2>/dev/null | awk 'NR==2{print $3\" / \"$2\" (\"$5\")\"}' || echo n/a)",
].join("; ");

interface Stat {
  key: string;
  label: string;
  icon: string;
}
const STATS: Stat[] = [
  { key: "OS", label: "OS", icon: "🐧" },
  { key: "KERNEL", label: "Kernel", icon: "🧬" },
  { key: "HOST", label: "Hostname", icon: "🏷️" },
  { key: "UPTIME", label: "Uptime", icon: "⏱️" },
  { key: "LOAD", label: "Load avg", icon: "📈" },
  { key: "CPU", label: "CPU cores", icon: "🧮" },
  { key: "MEM", label: "Memory", icon: "💾" },
  { key: "DISK", label: "Disk /", icon: "🗄️" },
];

function parseDashboard(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  let key = "";
  let buf: string[] = [];
  const flush = () => {
    if (key) out[key] = buf.join("\n").trim();
    buf = [];
  };
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^@@(\w+)@@$/);
    if (m) {
      flush();
      key = m[1];
    } else {
      buf.push(line);
    }
  }
  flush();
  return out;
}

/** On-demand server status panel, populated by one SSH exec. */
export class DashboardPanel {
  private backdrop = $<HTMLDivElement>("dash-backdrop");
  private titleEl = $<HTMLHeadingElement>("dash-title");
  private bodyEl = $<HTMLDivElement>("dash-body");
  private statusEl = $<HTMLDivElement>("dash-status");
  private conn?: Connection;

  constructor() {
    $("dash-close").addEventListener("click", () => this.close());
    $("dash-refresh").addEventListener("click", () => void this.load());
    this.backdrop.addEventListener("mousedown", (e) => {
      if (e.target === this.backdrop) this.close();
    });
  }

  async open(conn: Connection): Promise<void> {
    this.conn = conn;
    this.titleEl.textContent = `📊 ${conn.name || conn.host} — ${conn.username}@${conn.host}`;
    this.bodyEl.replaceChildren();
    this.backdrop.classList.remove("hidden");
    await this.load();
  }

  close(): void {
    this.backdrop.classList.add("hidden");
    this.conn = undefined;
  }

  hideForLock(): void {
    this.close();
  }

  private async load(): Promise<void> {
    if (!this.conn) return;
    this.setStatus("Fetching server status…");
    try {
      const raw = await api.sshRun(this.conn.id, DASHBOARD_CMD);
      this.render(parseDashboard(raw));
      this.setStatus("");
    } catch (e) {
      this.bodyEl.replaceChildren();
      this.setStatus(typeof e === "string" ? e : String(e), true);
    }
  }

  private render(data: Record<string, string>): void {
    this.bodyEl.replaceChildren();
    for (const stat of STATS) {
      const card = el("div", "dash-card");
      const head = el("div", "dash-card__head");
      head.append(el("span", "dash-card__icon", stat.icon));
      head.append(el("span", "dash-card__label", stat.label));
      card.append(head);
      card.append(el("div", "dash-card__value", data[stat.key] || "—"));
      this.bodyEl.append(card);
    }
  }

  private setStatus(msg: string, isError = false): void {
    this.statusEl.textContent = msg;
    this.statusEl.classList.toggle("error", isError);
  }
}
