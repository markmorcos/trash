import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { currentWeek } from "../shared/rotation";
import { readSession, safeEqual, sessionCookie } from "./auth";
import { isTestMode, now, setNow } from "./clock";
import { loadConfig, loadState, migrate, resetForTests, sql } from "./db";
import { remind, rollover } from "./jobs";
import { pushEnabled, vapidPublicKey } from "./push";
import { attach, broadcast, closeAll, listening } from "./ws";

const PORT = Number(process.env.PORT ?? 8080);
const here = fileURLToPath(new URL(".", import.meta.url));
const WEB_ROOT = resolve(process.env.WEB_ROOT ?? join(here, "web"));

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage): Promise<unknown> {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 16_384) throw new Error("too large");
  }
  return data ? JSON.parse(data) : {};
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, path: string) {
  const safe = normalize(path).replace(/^(\.\.[/\\])+/, "");
  let file = join(WEB_ROOT, safe);
  if (!file.startsWith(WEB_ROOT)) return json(res, 400, { error: "bad path" });
  let st = await stat(file).catch(() => null);
  if (!st || st.isDirectory()) {
    file = join(WEB_ROOT, "index.html");
    st = await stat(file).catch(() => null);
    if (!st) return json(res, 404, { error: "The web app isn't built. Run npm run build." });
  }
  const ext = extname(file);
  const immutable = safe.startsWith("/assets/");
  res.writeHead(200, {
    "Content-Type": TYPES[ext] ?? "application/octet-stream",
    "Content-Length": st.size,
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    ...(ext === ".html" ? { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin" } : {}),
  });
  if (req.method === "HEAD") return res.end();
  createReadStream(file).pipe(res);
}

const Me = z.object({ person: z.string().max(40).nullable() });
const Sub = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }),
});
const Unsub = z.object({ endpoint: z.string().max(1000) });

async function route(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  const p = url.pathname;
  const m = req.method ?? "GET";

  if (p === "/healthz") {
    await sql`select 1`;
    return json(res, listening ? 200 : 503, { ok: listening });
  }

  if (p.startsWith("/internal/")) {
    const token = process.env.CRON_TOKEN;
    const auth = req.headers.authorization ?? "";
    if (!token || !safeEqual(auth, `Bearer ${token}`)) return json(res, 401, { error: "unauthorized" });
    if (m === "POST" && p === "/internal/test/clock" && isTestMode()) {
      const { now: iso } = z.object({ now: z.string().datetime({ offset: true }) }).parse(await body(req));
      setNow(iso);
      void broadcast();
      return json(res, 200, { now: iso });
    }
    if (m === "POST" && p === "/internal/test/reset" && isTestMode()) {
      await resetForTests();
      void broadcast();
      return json(res, 200, { ok: true });
    }
    if (m === "POST" && p === "/internal/remind") return json(res, 200, await remind());
    if (m === "POST" && p === "/internal/rollover") {
      const r = await rollover();
      void broadcast();
      return json(res, 200, r);
    }
    return json(res, 404, { error: "not found" });
  }

  if (p.startsWith("/api/")) {
    const s = readSession(req);
    if (m === "GET" && p === "/api/session") {
      const { config } = await loadConfig();
      return json(res, 200, { person: s?.p ?? null, people: config.people, pushEnabled });
    }
    // No passcode: picking a name is all it takes. The cookie remembers it on this device.
    if (m === "POST" && p === "/api/me") {
      const { person } = Me.parse(await body(req));
      const { config } = await loadConfig();
      if (person && !config.people.some((x) => x.id === person)) return json(res, 400, { error: "Unknown person." });
      return json(res, 200, { person }, { "Set-Cookie": sessionCookie({ p: person, iat: Math.floor(Date.now() / 1000) }) });
    }
    if (!s?.p) return json(res, 401, { error: "Pick who you are first." });
    if (m === "GET" && p === "/api/state") {
      const { config } = await loadConfig();
      return json(res, 200, await loadState(currentWeek(now(), config.timezone)));
    }
    if (m === "GET" && p === "/api/push/key") return json(res, 200, { key: vapidPublicKey });
    if (m === "POST" && p === "/api/push/subscribe") {
      const sub = Sub.parse(await body(req));
      await sql`insert into push_subscriptions (endpoint, person, p256dh, auth)
        values (${sub.endpoint}, ${s.p}, ${sub.keys.p256dh}, ${sub.keys.auth})
        on conflict (endpoint) do update set person = excluded.person, p256dh = excluded.p256dh, auth = excluded.auth`;
      return json(res, 201, { ok: true });
    }
    if (m === "POST" && p === "/api/push/unsubscribe") {
      const { endpoint } = Unsub.parse(await body(req));
      await sql`delete from push_subscriptions where endpoint = ${endpoint}`;
      return json(res, 200, { ok: true });
    }
    if (m === "GET" && p === "/api/push/status") {
      const endpoint = url.searchParams.get("endpoint") ?? "";
      const [r] = await sql`select 1 from push_subscriptions where endpoint = ${endpoint} and person = ${s.p}`;
      return json(res, 200, { subscribed: Boolean(r) });
    }
    return json(res, 404, { error: "not found" });
  }

  if (m !== "GET" && m !== "HEAD") return json(res, 405, { error: "method not allowed" });
  return serveStatic(req, res, p);
}

await migrate();

const server = createServer((req, res) => {
  route(req, res).catch((e) => {
    if (e instanceof z.ZodError || e instanceof SyntaxError) return json(res, 400, { error: "Bad request." });
    console.error(req.method, req.url, e);
    if (!res.headersSent) json(res, 500, { error: "Something went wrong on the server." });
    else res.end();
  });
});
await attach(server);
server.listen(PORT, () => console.log(`trash listening on ${PORT}`));

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    console.log(`${sig}: closing`);
    closeAll();
    server.close(() => sql.end({ timeout: 5 }).then(() => process.exit(0)));
    setTimeout(() => process.exit(0), 8000).unref();
  });
}
