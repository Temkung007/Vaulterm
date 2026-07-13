/** Tiny non-blocking toast notifications. Stacks bottom-right, auto-dismisses.
 *
 * Purely cosmetic feedback ("Copied", "Saved", "Connected") — never use it for
 * anything the user must act on. Import { toast } and call it from anywhere. */

export type ToastKind = "info" | "success" | "error";

const ICONS: Record<ToastKind, string> = {
  info: "⚡",
  success: "✓",
  error: "⚠",
};

const MAX_VISIBLE = 4;

function container(): HTMLElement | null {
  return document.getElementById("toasts");
}

export function toast(message: string, kind: ToastKind = "info", ms = 2600): void {
  const host = container();
  if (!host) return;

  // Keep the stack short — drop the oldest if we're over the cap.
  while (host.children.length >= MAX_VISIBLE) {
    host.firstElementChild?.remove();
  }

  const el = document.createElement("div");
  el.className = `toast toast--${kind}`;
  el.setAttribute("role", "status");

  const icon = document.createElement("span");
  icon.className = "toast__icon";
  icon.textContent = ICONS[kind];

  const msg = document.createElement("span");
  msg.className = "toast__msg";
  msg.textContent = message;

  el.append(icon, msg);
  host.append(el);

  let removed = false;
  const remove = (): void => {
    if (removed) return;
    removed = true;
    el.classList.add("leaving");
    // Fall back to a timer in case the animation is disabled (reduced motion).
    const done = (): void => el.remove();
    el.addEventListener("animationend", done, { once: true });
    window.setTimeout(done, 260);
  };

  // Click to dismiss early; otherwise auto-dismiss.
  el.addEventListener("click", remove);
  window.setTimeout(remove, ms);
}
