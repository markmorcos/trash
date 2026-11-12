import type { ClientMessage, ServerMessage } from "../../shared/messages";
import { currentWeek, localDate, type Person, type State } from "../../shared/rotation";

type Status = "loading" | "who" | "ready";
export type Tab = "week" | "upcoming" | "changes" | "settings";

const CACHE = "trash:state";

function cached(): State | null {
  try {
    const raw = localStorage.getItem(CACHE);
    return raw ? (JSON.parse(raw) as State) : null;
  } catch {
    return null;
  }
}

export const app = $state({
  status: "loading" as Status,
  me: null as string | null,
  people: [] as Person[],
  state: cached(),
  online: false,
  presence: [] as string[],
  pushEnabled: false,
  tab: "week" as Tab,
  selectedWeek: null as string | null,
  toast: null as { title: string; body: string; kind: "info" | "error" } | null,
  now: new Date(),
});

export const tz = () => app.state?.config.timezone ?? "Europe/Berlin";
export const thisWeek = () => currentWeek(app.now, tz());
export const today = () => localDate(app.now, tz());
export const person = (id: string | null) =>
  app.state?.config.people.find((p) => p.id === id) ?? app.people.find((p) => p.id === id) ?? null;
export const nameOf = (id: string | null) => person(id)?.name ?? "Nobody";

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(title: string, body = "", kind: "info" | "error" = "info") {
  app.toast = { title, body, kind };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (app.toast = null), 4500);
}

// ---------- tabs via the URL hash ----------
const TABS: Tab[] = ["week", "upcoming", "changes", "settings"];
function readHash() {
  const h = location.hash.slice(1) as Tab;
  app.tab = TABS.includes(h) ? h : "week";
}
export function go(tab: Tab) {
  if (location.hash !== "#" + tab) location.hash = tab;
  app.tab = tab;
}

// ---------- session ----------
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    credentials: "same-origin",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
  return body as T;
}
export { api };

export async function init() {
  readHash();
  addEventListener("hashchange", readHash);
  setInterval(() => (app.now = new Date()), 30_000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      app.now = new Date();
      if (!app.online && app.status === "ready") reconnectNow();
    }
  });
  try {
    const s = await api<{ person: string | null; people: Person[]; pushEnabled: boolean }>("/api/session");
    app.pushEnabled = s.pushEnabled;
    app.people = s.people;
    if (!s.person) app.status = "who";
    else {
      app.me = s.person;
      app.status = "ready";
      connect();
    }
  } catch {
    // offline on first load: show the cached week if we have one
    app.status = app.state ? "ready" : "who";
    if (app.state) scheduleReconnect();
  }
}

export async function choose(personId: string) {
  await api("/api/me", { method: "POST", body: JSON.stringify({ person: personId }) });
  app.me = personId;
  app.status = "ready";
  go("week");
  connect();
}

export async function switchPerson() {
  await api("/api/me", { method: "POST", body: JSON.stringify({ person: null }) });
  app.me = null;
  closeSocket();
  app.status = "who";
}

// ---------- socket ----------
let ws: WebSocket | null = null;
let attempt = 0;
let retry: ReturnType<typeof setTimeout> | undefined;
let wanted = false;

function setState(s: State) {
  app.state = s;
  try {
    localStorage.setItem(CACHE, JSON.stringify(s));
  } catch {
    /* storage may be unavailable */
  }
}

export function connect() {
  wanted = true;
  clearTimeout(retry);
  if (ws && ws.readyState <= WebSocket.OPEN) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const sock = new WebSocket(`${proto}://${location.host}/ws`);
  ws = sock;
  sock.onopen = () => {
    attempt = 0;
    app.online = true;
    sock.send(JSON.stringify({ type: "hello", lastVersion: app.state?.version ?? 0 } satisfies ClientMessage));
  };
  sock.onmessage = (ev) => {
    const m = JSON.parse(ev.data) as ServerMessage;
    if (m.type === "state") setState(m.state);
    else if (m.type === "presence") app.presence = m.people;
    else if (m.type === "error") toast("That didn't work", m.message, "error");
  };
  sock.onclose = () => {
    if (ws === sock) ws = null;
    app.online = false;
    app.presence = [];
    if (wanted) scheduleReconnect();
  };
}

async function scheduleReconnect() {
  clearTimeout(retry);
  const delay = Math.min(30_000, 1000 * 2 ** attempt) * (0.8 + Math.random() * 0.4);
  attempt++;
  retry = setTimeout(async () => {
    // every few tries, check the session is still valid (e.g. cookie expired)
    if (attempt % 3 === 0) {
      try {
        const s = await api<{ person: string | null }>("/api/session");
        if (!s.person) {
          app.status = "who";
          wanted = false;
          return;
        }
      } catch {
        /* still offline */
      }
    }
    connect();
  }, delay);
}

function reconnectNow() {
  attempt = 0;
  connect();
}

function closeSocket() {
  wanted = false;
  clearTimeout(retry);
  ws?.close();
  ws = null;
}

export function send(msg: ClientMessage): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    toast("You're offline", "Reconnecting… try again in a moment.", "error");
    return false;
  }
  ws.send(JSON.stringify(msg));
  return true;
}
