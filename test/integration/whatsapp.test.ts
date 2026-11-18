// WhatsApp end to end: the real trash server and the real bridge process (with its
// fake WhatsApp connection) on one Postgres.
import { BufferJSON, initAuthCreds } from "@whiskeysockets/baileys";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { usePostgresAuthState } from "../../whatsapp/auth-store";
import { resetDb } from "../support/reset-db.mjs";
import { connect, cron, freePort, loginAs, startBridge, startPod, until, type Bridge, type Pod, type Sock } from "../support/server";

const dbUrl = process.env.TEST_DATABASE_URL;
const WEEK = "2026-11-09";
const FLAT = "120363000000000001@g.us";

describe.skipIf(!dbUrl)("WhatsApp group posts", () => {
  let sql: postgres.Sql;
  let pod: Pod;
  let bridge: Bridge;
  let liz: Sock;
  let lizCookie: string;
  const api = async (path: string, body?: unknown) => {
    const r = await fetch(pod.url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { cookie: lizCookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  const rows = () => sql`select id::int, kind, jid, text, status, attempts, last_error from wa_outbox order by id`;
  const sent = async () => (await bridge.call<{ jid: string; text: string }[]>("/fake/sent")).body;

  beforeAll(async () => {
    await resetDb(dbUrl);
    sql = postgres(dbUrl!, { max: 1, onnotice: () => {} });
    const port = await freePort();
    pod = await startPod({ WA_BRIDGE_URL: `http://127.0.0.1:${port}` });
    bridge = await startBridge(port);
    lizCookie = await loginAs(pod, "liz");
    liz = await connect(pod, lizCookie);
    await until(async () => (await api("/api/whatsapp")).body.state === "unlinked", "bridge ready");
  });

  afterAll(async () => {
    liz?.close();
    await Promise.all([pod?.stop(), bridge?.stop()]);
    await sql?.end();
  });

  describe("before a group is chosen", () => {
    it("shows the bridge as up and not linked", async () => {
      const { body } = await api("/api/whatsapp");
      expect(body).toMatchObject({ bridge: "up", state: "unlinked", target: null, groups: [] });
    });

    it("queues nothing for a take-out", async () => {
      liz.send({ type: "checkoff", week: WEEK, bin: "wert" });
      await liz.next("state", (m) => m.state.takeouts.length === 1);
      expect(await rows()).toEqual([]);
    });

    it("refuses a test message", async () => {
      expect((await api("/api/whatsapp/test", {})).status).toBe(409);
    });
  });

  describe("linking", () => {
    it("rejects a number without enough digits", async () => {
      const r = await api("/api/whatsapp/link", { phone: "12" });
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(/country code/);
    });

    it("a code stops showing after 3 minutes, with a message to get a new one", async () => {
      await api("/api/whatsapp/link", { phone: "+49 170 1234567" });
      expect((await api("/api/whatsapp")).body.state).toBe("pairing");
      await bridge.call("/fake/advance", { ms: 3 * 60_000 + 1000 });
      expect((await api("/api/whatsapp")).body).toMatchObject({
        state: "unlinked",
        code: null,
        error: "That code expired or didn't work. Get a new one.",
      });
    });

    it("a dropped connection kills the code and shows why, without secrets", async () => {
      await api("/api/whatsapp/link", { phone: "+49 170 1234567" });
      await bridge.call("/fake/close-socket", { code: 405 });
      const st = (await api("/api/whatsapp")).body;
      expect(st).toMatchObject({ state: "unlinked", code: null, error: "That code expired or didn't work. Get a new one." });
      expect(st.lastProblem).toMatchObject({ code: 405, reason: "rejected by WhatsApp (often an outdated client version) (405)" });
      for (const k of await sql`select key from wa_auth`) expect(JSON.stringify(st)).not.toContain(k.key);
    });

    it("asking again replaces the code", async () => {
      const first = (await api("/api/whatsapp/link", { phone: "+49 170 1234567" })).body.code;
      const second = (await api("/api/whatsapp/link", { phone: "+49 170 1234567" })).body.code;
      expect(second).not.toBe(first);
      // the second code comes from a fresh session, never from the first attempt's keys
      const info = (await bridge.call<{ sessions: number }>("/fake/info")).body;
      expect(info.sessions).toBeGreaterThan(1);
      expect((await api("/api/whatsapp")).body).toMatchObject({ state: "pairing", code: second });
    });

    it("hands out a link code, then shows the linked number masked", async () => {
      const r = await api("/api/whatsapp/link", { phone: "+49 170 1234567" });
      expect(r.body.code).toMatch(/^[A-Z0-9]{8}$/);
      expect((await api("/api/whatsapp")).body).toMatchObject({ state: "pairing", code: r.body.code });
      await bridge.call("/fake/complete-link");
      const st = (await api("/api/whatsapp")).body;
      expect(st).toMatchObject({ state: "linked", me: "+49 ••• ••• 567", code: null });
      expect(st.groups.map((g: { name: string }) => g.name)).toEqual(["🏠 Flat", "Family"]);
      // the full number never reaches the app
      expect(JSON.stringify(st)).not.toContain("491701234567");
    });

    it("never exposes the login keys through the app", async () => {
      const st = JSON.stringify((await api("/api/whatsapp")).body);
      const keys = await sql`select key from wa_auth`;
      expect(keys.length).toBeGreaterThan(0);
      for (const k of keys) expect(st).not.toContain(k.key);
    });
  });

  describe("choosing the group", () => {
    it("only accepts a group the number is in", async () => {
      expect((await api("/api/whatsapp/group", { jid: "999@g.us" })).status).toBe(404);
      expect((await api("/api/whatsapp/group", { jid: "not a jid" })).status).toBe(400);
    });

    it("records the choice as an event everyone sees", async () => {
      const r = await api("/api/whatsapp/group", { jid: FLAT });
      expect(r.body.target).toEqual({ jid: FLAT, name: "🏠 Flat", enabled: true });
      const m = await liz.next("state", (x) => x.state.whatsapp?.jid === FLAT);
      expect(m.state.activity[0]).toMatchObject({ actor: "liz", data: { type: "whatsapp.group_set", name: "🏠 Flat" } });
    });
  });

  describe("posting", () => {
    it("a take-out queues one post in the same transaction as its event, and the bridge sends it", async () => {
      liz.send({ type: "checkoff", week: WEEK, bin: "wert" });
      await liz.next("state", (m) => m.state.takeouts.length === 2);
      // events are never updated, so their xmin is still the inserting transaction
      const [same] = await sql`select
        (select xmin::text::bigint from events where type = 'bin.taken_out' order by id desc limit 1) =
        (select created_txid % 4294967296 from wa_outbox order by id desc limit 1) as same`;
      expect(same.same).toBe(true);
      await until(async () => (await sent()).length === 1, "the post to be sent");
      expect(await sent()).toEqual([{ jid: FLAT, text: "🗑️ Liz took out Wertstoff again (2nd time this week)", at: expect.any(String) }]);
      expect((await rows())[0]).toMatchObject({ status: "sent", attempts: 1 });
    });

    it("a refused action queues nothing (the transaction rolled back)", async () => {
      const before = (await rows()).length;
      liz.send({ type: "checkoff", week: WEEK, bin: "bio" }); // Francisco's bin
      expect((await liz.next("error")).code).toBe("not_allowed");
      expect((await rows()).length).toBe(before);
    });

    it("sends several posts in the order they happened", async () => {
      const mark = await connect(pod, await loginAs(pod, "mark"));
      mark.send({ type: "override", week: "2026-11-23", kind: "away" });
      await mark.next("state", (m) => m.state.overrides.some((o) => o.week === "2026-11-23"));
      liz.send({ type: "override", week: "2026-11-30", kind: "swap", with: "lea" });
      await liz.next("state", (m) => m.state.overrides.some((o) => o.kind === "swap"));
      mark.close();
      await until(async () => (await sent()).length === 3, "three posts");
      expect((await sent()).slice(1).map((p) => p.text)).toEqual([
        "🥧 Mark is away the week of 23 Nov · on break then anyway",
        "🔁 Liz and Lea swapped for the week of 30 Nov · Liz has Papier, Lea has a break",
      ]);
    });

    it("sends a test message", async () => {
      expect((await api("/api/whatsapp/test", {})).status).toBe(202);
      await until(async () => (await sent()).some((p) => p.text === "🧪 Test from the trash rota (sent by Liz)"), "test post");
    });
  });

  describe("when sending fails", () => {
    it("records the error, keeps later posts waiting, and retries after the backoff", async () => {
      await bridge.call("/fake/fail", { count: 1 });
      const n = (await sent()).length;
      await api("/api/whatsapp/test", {});
      await until(async () => (await rows()).at(-1)!.attempts === 1, "the failed attempt");
      expect((await rows()).at(-1)).toMatchObject({ status: "pending", last_error: "fake send failure" });
      expect((await api("/api/whatsapp")).body.outbox).toMatchObject({ pending: 1, lastError: "fake send failure" });
      // pretend the 30 s backoff has passed
      await sql`update wa_outbox set last_tried_at = now() - interval '1 hour' where status = 'pending'`;
      await bridge.call("/drain");
      await until(async () => (await sent()).length === n + 1, "the retry");
      expect((await rows()).at(-1)).toMatchObject({ status: "sent", attempts: 2 });
    });

    it("gives up after 5 attempts", async () => {
      await sql`insert into wa_outbox (kind, jid, text, attempts, last_tried_at) values ('test', ${FLAT}, 'doomed', 5, now() - interval '1 hour')`;
      await bridge.call("/drain");
      await until(async () => (await rows()).at(-1)!.status === "failed", "failed status");
      expect((await sent()).some((p) => p.text === "doomed")).toBe(false);
    });

    it("drops posts older than 12 hours instead of flooding the group", async () => {
      await sql`insert into wa_outbox (kind, jid, text, created_at) values ('test', ${FLAT}, 'stale news', now() - interval '13 hours')`;
      await bridge.call("/drain");
      await until(async () => (await rows()).at(-1)!.status === "expired", "expired status");
      expect((await sent()).some((p) => p.text === "stale news")).toBe(false);
    });
  });

  describe("scheduled posts", () => {
    it("the Sunday reminder and Monday rota are queued once, even when the jobs re-run", async () => {
      await cron(pod, "/internal/test/clock", { now: "2026-11-15T18:00:00+01:00" });
      expect((await (await cron(pod, "/internal/remind")).json()).whatsapp).toBe(true);
      expect((await (await cron(pod, "/internal/remind")).json()).whatsapp).toBe(false);
      await cron(pod, "/internal/test/clock", { now: "2026-11-16T00:05:00+01:00" });
      expect((await (await cron(pod, "/internal/rollover")).json()).whatsapp).toBe(true);
      expect((await (await cron(pod, "/internal/rollover")).json()).whatsapp).toBe(false);
      const kinds = (await rows()).map((r) => r.kind);
      expect(kinds.filter((k) => k === "remind")).toHaveLength(1);
      expect(kinds.filter((k) => k === "newweek")).toHaveLength(1);
      await until(async () => (await sent()).some((p) => p.text.startsWith("📅 New week, 16–22 Nov")), "rota post");
      expect((await sent()).find((p) => p.text.startsWith("⏰ Sunday"))!.text).toContain("Restmüll (Lea)");
    });
  });

  describe("turning off", () => {
    it("stops queueing and records who did it", async () => {
      const r = await api("/api/whatsapp/off", {});
      expect(r.body.target).toMatchObject({ enabled: false });
      const before = (await rows()).length;
      liz.send({ type: "checkoff", week: "2026-11-16", bin: "bio" });
      await liz.next("state", (m) => m.state.takeouts.some((t) => t.week === "2026-11-16"));
      expect((await rows()).length).toBe(before);
      const [e] = await sql`select actor from events where type = 'whatsapp.turned_off'`;
      expect(e.actor).toBe("liz");
    });
  });

  describe("one sender at a time", () => {
    it("a second bridge waits, then takes over when the first stops, still linked", async () => {
      const second = await startBridge();
      try {
        await new Promise((r) => setTimeout(r, 800));
        expect((await (await fetch(second.url + "/healthz")).json()).lock).toBe(false);
        await bridge.stop();
        await until(async () => (await (await fetch(second.url + "/healthz")).json()).lock === true, "takeover");
        await until(async () => (await second.call<{ state: string }>("/status")).body.state === "linked", "still linked");
      } finally {
        await second.stop();
      }
    });
  });
});

describe.skipIf(!dbUrl)("WhatsApp login storage", () => {
  let sql: postgres.Sql;
  beforeAll(async () => {
    sql = postgres(dbUrl!, { max: 2, onnotice: () => {} });
    await sql`create table if not exists wa_auth (key text primary key, value text not null, updated_at timestamptz not null default now())`;
    await sql`delete from wa_auth`;
  });
  afterAll(async () => sql?.end());

  it("survives a restart: creds and keys read back byte for byte", async () => {
    const a = await usePostgresAuthState(sql);
    a.state.creds.registered = true;
    await a.saveCreds();
    await a.state.keys.set({ "pre-key": { "1": { public: Buffer.from([1, 2, 3]), private: Buffer.from([4, 5, 6]) } } });

    const b = await usePostgresAuthState(sql);
    expect(b.state.creds.registered).toBe(true);
    expect(JSON.stringify(b.state.creds, BufferJSON.replacer)).toBe(JSON.stringify(a.state.creds, BufferJSON.replacer));
    const keys = await b.state.keys.get("pre-key", ["1", "2"]);
    expect(Buffer.from(keys["1"].private)).toEqual(Buffer.from([4, 5, 6]));
    expect(keys["2"]).toBeUndefined();
  });

  it("deletes keys set to null, and clear() forgets the device", async () => {
    const a = await usePostgresAuthState(sql);
    await a.state.keys.set({ "pre-key": { "1": null } });
    expect(await a.state.keys.get("pre-key", ["1"])).toEqual({});
    await a.clear();
    const fresh = await usePostgresAuthState(sql);
    expect(fresh.state.creds.registered).toBe(false);
    expect(fresh.state.creds.noiseKey.public).not.toEqual(initAuthCreds().noiseKey.public);
  });
});
