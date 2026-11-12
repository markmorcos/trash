import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import WebSocket from "ws";
import type { ClientMessage, ServerMessage } from "../../src/shared/messages";

export const TEST_ENV = {
  SESSION_SECRET: "integration-secret",
  CRON_TOKEN: "integration-cron",
  TRASH_TEST_MODE: "1",
  // Wednesday 11 Nov 2026, 12:00 Berlin: the week of 9 Nov (Mark away, Francisco covering)
  TRASH_FAKE_NOW: "2026-11-11T12:00:00+01:00",
};

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

export interface Pod {
  url: string;
  stop: () => Promise<void>;
  logs: string[];
}

/** Start one server process ("pod") against the test database. */
export async function startPod(extraEnv: Record<string, string> = {}): Promise<Pod> {
  const port = await freePort();
  const logs: string[] = [];
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
    env: { ...process.env, ...TEST_ENV, DATABASE_URL: process.env.TEST_DATABASE_URL!, PORT: String(port), WEB_ROOT: "dist/web", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.on("data", (d) => logs.push(String(d)));
  child.stderr!.on("data", (d) => logs.push(String(d)));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error("server exited:\n" + logs.join(""));
    try {
      const r = await fetch(url + "/healthz");
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("server didn't start:\n" + logs.join(""));
    await new Promise((r) => setTimeout(r, 150));
  }
  return {
    url,
    logs,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      }),
  };
}

/** Pick a person (no passcode); returns the cookie header. */
export async function loginAs(pod: Pod, person: string): Promise<string> {
  const me = await fetch(pod.url + "/api/me", { method: "POST", body: JSON.stringify({ person }) });
  if (!me.ok) throw new Error("me failed " + me.status);
  return me.headers.get("set-cookie")!.split(";")[0];
}

export interface Sock {
  send: (m: ClientMessage) => void;
  /** Resolve with the next message matching the predicate (messages already received count). */
  next: <T extends ServerMessage["type"]>(
    type: T,
    pred?: (m: Extract<ServerMessage, { type: T }>) => boolean,
    timeoutMs?: number,
  ) => Promise<Extract<ServerMessage, { type: T }>>;
  close: () => void;
}

const inboxes = new Set<ServerMessage[]>();

/**
 * Open a socket as a logged-in person. Every send() clears all open test sockets'
 * inboxes first, so next() only sees messages caused after the latest action.
 */
export async function connect(pod: Pod, cookie: string): Promise<Sock> {
  const ws = new WebSocket(pod.url.replace("http", "ws") + "/ws", { headers: { cookie } });
  const inbox: ServerMessage[] = [];
  inboxes.add(inbox);
  const waiters: (() => void)[] = [];
  ws.on("message", (raw) => {
    inbox.push(JSON.parse(String(raw)));
    waiters.splice(0).forEach((w) => w());
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("unexpected-response", (_req, res) => reject(new Error(`upgrade refused: ${res.statusCode}`)));
    ws.once("error", reject);
  });
  return {
    send: (m) => {
      for (const box of inboxes) box.length = 0;
      ws.send(JSON.stringify(m));
    },
    close: () => {
      inboxes.delete(inbox);
      ws.close();
    },
    next: (type, pred = () => true, timeoutMs = 5000) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ${type} message within ${timeoutMs} ms`)), timeoutMs);
        const check = () => {
          const i = inbox.findIndex((m) => m.type === type && pred(m as never));
          if (i >= 0) {
            clearTimeout(timer);
            resolve(inbox.splice(i, 1)[0] as never);
          } else waiters.push(check);
        };
        check();
      }),
  };
}

/** Raw upgrade attempt, for checking refusals. */
export function tryConnect(pod: Pod, cookie?: string): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(pod.url.replace("http", "ws") + "/ws", { headers: cookie ? { cookie } : {} });
    ws.once("open", () => {
      ws.close();
      resolve(101);
    });
    ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.once("error", () => resolve(0));
  });
}

export const cron = (pod: Pod, path: string, body?: unknown) =>
  fetch(pod.url + path, {
    method: "POST",
    headers: { authorization: `Bearer ${TEST_ENV.CRON_TOKEN}` },
    body: body ? JSON.stringify(body) : undefined,
  });
