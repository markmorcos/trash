// Browser side of installing the app: the Chrome/Edge install prompt, whether we
// already run installed, and the dismissible hint on This week.
import { detectPlatform, installGuide, type Platform } from "./platform";

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const HINT_KEY = "trash:install-hint-dismissed";

function standalone(): boolean {
  return (
    matchMedia("(display-mode: standalone)").matches ||
    matchMedia("(display-mode: window-controls-overlay)").matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function hintDismissed(): boolean {
  try {
    return localStorage.getItem(HINT_KEY) === "1";
  } catch {
    return false;
  }
}

export const install = $state({
  platform: detectPlatform({ userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints }) as Platform,
  installed: standalone(),
  canPrompt: false,
  hintDismissed: hintDismissed(),
});

let deferred: InstallPromptEvent | null = null;

// Registered when this module loads (from main.ts), before the browser fires it.
addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferred = e as InstallPromptEvent;
  install.canPrompt = true;
});
addEventListener("appinstalled", () => {
  install.installed = true;
  install.canPrompt = false;
  deferred = null;
});
matchMedia("(display-mode: standalone)").addEventListener?.("change", () => (install.installed = standalone()));

export const guide = () => installGuide(install.platform, install.canPrompt);

/** Show the browser's own install dialog. Must run from a tap or click. */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  if (!deferred) return "unavailable";
  const e = deferred;
  deferred = null;
  install.canPrompt = false;
  await e.prompt();
  const { outcome } = await e.userChoice;
  if (outcome === "accepted") install.installed = true;
  return outcome;
}

export function dismissHint() {
  install.hintDismissed = true;
  try {
    localStorage.setItem(HINT_KEY, "1");
  } catch {
    /* storage may be unavailable; the hint just comes back next time */
  }
}
