// WhatsApp bridge: holds the linked-device session and posts queued rota updates
// (wa_outbox, written by the trash server) into the chosen group. Post only: it
// never reads, answers or stores incoming messages.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import postgres from "postgres";
import { SEND_GAP_MS, nextStep } from "../src/shared/whatsapp";
import { BaileysTransport, FakeTransport, type Transport } from "./transport";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const PORT = Number(process.env.PORT ?? 8081);
const TOKEN = process.env.CRON_TOKEN ?? "";
const fake = process.env.WA_FAKE === "1" && process.env.TRASH_TEST_MODE === "1" && process.env.NODE_ENV !== "production";
const gap = fake ? Number(process.env.WA_SEND_GAP_MS ?? 50) : SEND_GAP_MS;
const LOCK = 7320;

const sql = postgres(url, { max: 4, idle_timeout: 30, onnotice: () => {} });
const transport: Transport = fake ? new FakeTransport(sql) : new BaileysTransport(sql);
let lockHeld = false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => console.log(`whatsapp: ${m}`);

// ---------- sending ----------

let draining = false;
let again = false;
/** Send pending posts in order. A post that must wait holds back the ones after it. */
async function drain() {
  if (!lockHeld || transport.status().state !== "linked") return;
  if (draining) {
    again = true;
    return;
  }
  draining = true;
  try {
    do {
      again = false;
      const rows = await sql`select id, jid, text, created_at, attempts, last_tried_at from wa_outbox
        where status = 'pending' order by id limit 20`;
      for (const r of rows) {
        const step = nextStep(
          { createdAt: +new Date(r.created_at), attempts: r.attempts, lastTriedAt: r.last_tried_at ? +new Date(r.last_tried_at) : null },
          Date.now(),
        );
        if (step === "expire") {
          await sql`update wa_outbox set status = 'expired' where id = ${r.id}`;
          continue;
        }
        if (step === "fail") {
          await sql`update wa_outbox set status = 'failed' where id = ${r.id}`;
          continue;
        }
        if (step === "wait") break;
        try {
          await transport.send(r.jid, r.text);
          await sql`update wa_outbox set status = 'sent', sent_at = now(), attempts = attempts + 1, last_tried_at = now() where id = ${r.id}`;
          await sleep(gap);
        } catch (e) {
          const msg = (e as Error).message.slice(0, 200);
          await sql`update wa_outbox set attempts = attempts + 1, last_tried_at = now(), last_error = ${msg} where id = ${r.id}`;
          log(`post ${r.id} failed (${msg}), will retry`);
          break;
        }
      }
    } while (again);
  } catch (e) {
    log(`drain failed: ${(e as Error).message}`);
  } finally {
    draining = false;
  }
}

// ---------- one sender at a time ----------

/**
 * Hold a session advisory lock for as long as this process runs. During a rolling
 * deploy the new pod waits here until the old one exits, so two copies never share
 * the WhatsApp session.
 */
async function holdLock() {
  const c = await sql.reserve();
  for (;;) {
    const [{ ok }] = await c`select pg_try_advisory_lock(${LOCK}) as ok`;
    if (ok) break;
    await sleep(fake ? 200 : 2000);
  }
  lockHeld = true;
  log("lock acquired, connecting");
  // if the lock's connection dies the lock is gone: stop, and let Kubernetes restart us
  setInterval(() => {
    c`select 1`.catch(() => {
      log("lost the database connection that holds the lock; exiting");
      process.exit(1);
    });
  }, 10_000).unref();
}

async function waitForTables() {
  for (;;) {
    const [{ ok }] = await sql`select to_regclass('public.wa_outbox') is not null and to_regclass('public.wa_auth') is not null as ok`;
    if (ok) return;
    log("waiting for the trash server to create its tables");
    await sleep(2000);
  }
}

// ---------- HTTP API (cluster-internal, bearer CRON_TOKEN) ----------

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let d = "";
  for await (const ch of req) {
    d += ch;
    if (d.length > 4096) throw new Error("too large");
  }
  return d ? JSON.parse(d) : {};
}
const authorized = (req: IncomingMessage) => {
  const a = Buffer.from(req.headers.authorization ?? "");
  const b = Buffer.from(`Bearer ${TOKEN}`);
  return TOKEN.length > 0 && a.length === b.length && timingSafeEqual(a, b);
};

const server = createServer(async (req, res) => {
  try {
    const p = new URL(req.url ?? "/", "http://x").pathname;
    const m = req.method ?? "GET";
    if (p === "/healthz") return json(res, 200, { ok: true, lock: lockHeld });
    if (!authorized(req)) return json(res, 401, { error: "unauthorized" });

    if (m === "GET" && p === "/status") {
      const st = transport.status();
      return json(res, 200, { lock: lockHeld, ...st, groups: lockHeld ? await transport.groups() : [] });
    }
    if (m === "POST" && p === "/link") {
      if (!lockHeld) return json(res, 409, { error: "The bridge is still starting. Try again in a moment." });
      const phone = String((await body(req)).phone ?? "").replace(/\D/g, "");
      if (phone.length < 8 || phone.length > 15) return json(res, 400, { error: "Enter the full number with country code, e.g. +49 170 1234567." });
      if (transport.status().state === "linked") return json(res, 409, { error: "Already linked." });
      return json(res, 200, { code: await transport.link(phone) });
    }
    if (m === "POST" && p === "/unlink") {
      await transport.unlink();
      return json(res, 200, { ok: true });
    }
    if (m === "POST" && p === "/drain") {
      await drain();
      return json(res, 200, { ok: true });
    }
    if (fake && p.startsWith("/fake/")) {
      const f = transport as FakeTransport;
      if (m === "POST" && p === "/fake/complete-link") {
        await f.completeLink();
        return json(res, 200, { ok: true });
      }
      if (m === "POST" && p === "/fake/fail") {
        f.failNext = Number((await body(req)).count ?? 1);
        return json(res, 200, { ok: true });
      }
      if (m === "GET" && p === "/fake/sent") return json(res, 200, f.sent);
      if (m === "POST" && p === "/fake/reset") {
        await f.unlink();
        f.sent = [];
        f.failNext = 0;
        return json(res, 200, { ok: true });
      }
    }
    return json(res, 404, { error: "not found" });
  } catch (e) {
    console.error("whatsapp: request failed", (e as Error).message);
    if (!res.headersSent) json(res, 500, { error: (e as Error).message });
  }
});

server.listen(PORT, () => log(`listening on ${PORT}${fake ? " (fake transport)" : ""}`));

await waitForTables();
await holdLock();
transport.onLinked(() => void drain());
await transport.start();

// new posts arrive by NOTIFY; the interval retries after backoffs
await sql.listen("wa_outbox", () => void drain());
setInterval(() => void drain(), fake ? 500 : 5000).unref();

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, async () => {
    log(`${sig}: closing`);
    await transport.stop();
    server.close();
    await sql.end({ timeout: 3 }).catch(() => {});
    process.exit(0);
  });
}
