import { api } from "./app.svelte";

export type PushSupport = "ok" | "ios-install" | "unsupported" | "denied";

const isIOS = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = () =>
  matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;

export function pushSupport(): PushSupport {
  if (isIOS() && !standalone()) return "ios-install";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  return "ok";
}

function keyBytes(base64: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function registration() {
  return navigator.serviceWorker.ready;
}

export async function isSubscribed(): Promise<boolean> {
  if (pushSupport() !== "ok") return false;
  const sub = await (await registration()).pushManager.getSubscription();
  if (!sub) return false;
  const r = await api<{ subscribed: boolean }>(`/api/push/status?endpoint=${encodeURIComponent(sub.endpoint)}`);
  return r.subscribed;
}

/** Must be called from a tap: browsers only show the permission prompt for a user gesture. */
export async function subscribe(): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notifications are blocked. Allow them in the browser's site settings.");
  const { key } = await api<{ key: string | null }>("/api/push/key");
  if (!key) throw new Error("Reminders aren't set up on the server yet.");
  const reg = await registration();
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }));
  const json = sub.toJSON();
  await api("/api/push/subscribe", {
    method: "POST",
    body: JSON.stringify({ endpoint: sub.endpoint, keys: json.keys }),
  });
}

export async function unsubscribe(): Promise<void> {
  const sub = await (await registration()).pushManager.getSubscription();
  if (!sub) return;
  await api("/api/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: sub.endpoint }) });
  await sub.unsubscribe();
}
