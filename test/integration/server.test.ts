// End-to-end through the real server: HTTP API, WebSockets, Postgres LISTEN/NOTIFY
// across two server processes (like two pods during a rolling deploy), and the
// scheduled jobs. Needs TEST_DATABASE_URL pointing at a disposable database.
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assignWeek, type State } from "../../src/shared/rotation";
import { resetDb } from "../support/reset-db.mjs";
import { connect, cron, loginAs, startPod, tryConnect, type Pod, type Sock } from "../support/server";

const dbUrl = process.env.TEST_DATABASE_URL;
const WEEK = "2026-11-09";
const names = (s: State, week = WEEK) => assignWeek(s.config, s.overrides, week).bins.map((b) => b.person);

describe.skipIf(!dbUrl)("server integration", () => {
  let a: Pod;
  let b: Pod;
  let sql: postgres.Sql;
  let lizCookie: string;
  let markCookie: string;
  let liz: Sock;
  let mark: Sock;

  beforeAll(async () => {
    await resetDb(dbUrl);
    a = await startPod();
    b = await startPod();
    sql = postgres(dbUrl!, { max: 1, onnotice: () => {} });
    lizCookie = await loginAs(a, "liz");
    markCookie = await loginAs(b, "mark");
    liz = await connect(a, lizCookie);
    mark = await connect(b, markCookie);
  });

  afterAll(async () => {
    liz?.close();
    mark?.close();
    await Promise.all([a?.stop(), b?.stop()]);
    await sql?.end();
  });

  describe("first start", () => {
    it("is healthy and seeds the fridge with Mark away on 9 Nov", async () => {
      expect((await fetch(a.url + "/healthz")).status).toBe(200);
      const r = await fetch(a.url + "/api/state", { headers: { cookie: lizCookie } });
      const s = (await r.json()) as State;
      expect(s.config.order).toEqual(["lea", "liz", "mark", "ari", "francisco"]);
      expect(names(s)).toEqual(["lea", "liz", "francisco", "ari"]);
    });

    it("seeds only once even with two pods starting", async () => {
      const [{ n }] = await sql`select count(*)::int as n from overrides`;
      expect(n).toBe(1);
    });
  });

  describe("auth", () => {
    it("rejects a wrong passcode with a clear message", async () => {
      const r = await fetch(a.url + "/api/login", { method: "POST", body: JSON.stringify({ passcode: "0000" }) });
      expect(r.status).toBe(401);
      expect((await r.json()).error).toMatch(/passcode is wrong/);
    });

    it("needs a session for the API and a chosen person for the socket", async () => {
      expect((await fetch(a.url + "/api/state")).status).toBe(401);
      expect(await tryConnect(a)).toBe(401);
      const login = await fetch(a.url + "/api/login", { method: "POST", body: JSON.stringify({ passcode: "4711" }) });
      const halfCookie = login.headers.get("set-cookie")!.split(";")[0];
      expect(await tryConnect(a, halfCookie)).toBe(401);
      expect(await tryConnect(a, lizCookie)).toBe(101);
    });

    it("refuses unknown people", async () => {
      const r = await fetch(a.url + "/api/me", { method: "POST", headers: { cookie: lizCookie }, body: JSON.stringify({ person: "eve" }) });
      expect(r.status).toBe(400);
    });

    it("protects the cron endpoints", async () => {
      expect((await fetch(a.url + "/internal/remind", { method: "POST" })).status).toBe(401);
      const wrong = await fetch(a.url + "/internal/remind", { method: "POST", headers: { authorization: "Bearer nope" } });
      expect(wrong.status).toBe(401);
    });
  });

  describe("live sync across pods", () => {
    it("answers hello with the full state", async () => {
      liz.send({ type: "hello", lastVersion: 0 });
      const m = await liz.next("state");
      expect(m.state.version).toBeGreaterThanOrEqual(1);
    });

    it("a tick on pod A reaches a phone on pod B", async () => {
      liz.send({ type: "checkoff", week: WEEK, bin: "wert" });
      const m = await mark.next("state", (x) => x.state.checkoffs.some((c) => c.bin === "wert"));
      expect(m.state.checkoffs.find((c) => c.bin === "wert")).toMatchObject({ person: "liz", doneBy: "liz" });
    });

    it("refuses ticking someone else's bin", async () => {
      mark.send({ type: "checkoff", week: WEEK, bin: "bio" });
      const e = await mark.next("error");
      expect(e.code).toBe("not_allowed");
    });

    it("refuses ticking a week that isn't this one", async () => {
      liz.send({ type: "checkoff", week: "2026-11-16", bin: "bio" });
      expect((await liz.next("error")).code).toBe("not_allowed");
    });

    it("shows who is online on the same pod", async () => {
      const ari = await connect(a, await loginAs(a, "ari"));
      const p = await liz.next("presence", (x) => x.people.includes("ari"));
      expect(p.people.sort()).toEqual(["ari", "liz"]);
      ari.close();
    });
  });

  describe("away and swaps", () => {
    it("Liz away on 23 Nov: Mark, on break, covers Papier", async () => {
      liz.send({ type: "override", week: "2026-11-23", kind: "away" });
      const m = await mark.next("state", (x) => x.state.overrides.some((o) => o.week === "2026-11-23"));
      // 23 Nov base: Ari, Francisco, Lea, Liz | Mark rests. Liz (Papier) away → Mark covers.
      expect(names(m.state, "2026-11-23")).toEqual(["ari", "francisco", "lea", "mark"]);
    });

    it("rejects marking the same week twice", async () => {
      liz.send({ type: "override", week: "2026-11-23", kind: "away" });
      expect((await liz.next("error")).code).toBe("already_away");
    });

    it("rejects swapping with someone who is away", async () => {
      mark.send({ type: "override", week: "2026-11-23", kind: "swap", with: "liz" });
      expect((await mark.next("error")).code).toBe("partner_away");
    });

    it("swaps for one week only", async () => {
      mark.send({ type: "override", week: "2026-11-30", kind: "swap", with: "lea" });
      const m = await liz.next("state", (x) => x.state.overrides.some((o) => o.kind === "swap"));
      // 30 Nov base: Mark, Ari, Francisco, Lea | Liz rests → swap Mark/Lea
      expect(names(m.state, "2026-11-30")).toEqual(["lea", "ari", "francisco", "mark"]);
      expect(names(m.state, "2026-12-07")).toEqual(["liz", "mark", "ari", "francisco"]);
    });

    it("rejects changes to past weeks", async () => {
      liz.send({ type: "override", week: "2026-11-02", kind: "away" });
      expect((await liz.next("error")).code).toBe("not_allowed");
    });

    it("undo removes the change for everyone", async () => {
      const [row] = await sql`select id from overrides where kind = 'swap'`;
      liz.send({ type: "undoOverride", id: row.id });
      const m = await mark.next("state", (x) => !x.state.overrides.some((o) => o.kind === "swap"));
      expect(names(m.state, "2026-11-30")).toEqual(["mark", "ari", "francisco", "lea"]);
    });
  });

  describe("shared settings", () => {
    it("applies a new lineup from this week on", async () => {
      liz.send({ type: "hello" });
      const { state } = await liz.next("state");
      const lineup = ["liz", "lea", "francisco", "ari", "mark"];
      liz.send({ type: "updateConfig", baseRev: state.config.rev, lineup });
      const m = await mark.next("state", (x) => x.state.config.rev === state.config.rev + 1);
      expect(m.state.config.anchorWeek).toBe(WEEK);
      expect(m.state.config.order).toEqual(lineup);
    });

    it("rejects a stale edit and sends the latest settings back", async () => {
      mark.send({ type: "updateConfig", baseRev: 1, names: { mark: "Marco" } });
      expect((await mark.next("error")).code).toBe("stale_config");
      const m = await mark.next("state");
      expect(m.state.config.people.find((p) => p.id === "mark")!.name).toBe("Mark");
    });

    it("restores the fridge lineup", async () => {
      liz.send({ type: "hello" });
      const { state } = await liz.next("state");
      liz.send({ type: "updateConfig", baseRev: state.config.rev, lineup: ["lea", "liz", "mark", "ari", "francisco"] });
      const m = await liz.next("state", (x) => x.state.config.rev === state.config.rev + 1);
      expect(names(m.state)).toEqual(["lea", "liz", "francisco", "ari"]);
    });
  });

  describe("scheduled jobs", () => {
    it("Sunday reminder lists only bins still out, and never sends twice", async () => {
      await cron(a, "/internal/test/clock", { now: "2026-11-15T18:00:00+01:00" });
      const first = await (await cron(a, "/internal/remind")).json();
      expect(first.week).toBe(WEEK);
      expect(first.pending).toEqual({ lea: ["Restmüll"], francisco: ["Biomüll"], ari: ["Papier"] });
      const again = await (await cron(a, "/internal/remind")).json();
      expect(Object.values(again.sent)).toEqual(["already sent", "already sent", "already sent"]);
    });

    it("Monday rollover records done and missed bins and tells every open phone", async () => {
      await Promise.all([
        cron(a, "/internal/test/clock", { now: "2026-11-16T00:05:00+01:00" }),
        cron(b, "/internal/test/clock", { now: "2026-11-16T00:05:00+01:00" }),
      ]);
      const r = await (await cron(a, "/internal/rollover")).json();
      expect(r.closed).toBe(WEEK);
      expect(r.week).toBe("2026-11-16");
      expect(r.missed.sort()).toEqual(["bio", "papier", "rest"]);
      const m = await mark.next("state", (x) => x.state.history.length > 0);
      expect(m.state.history.find((h) => h.bin === "wert")).toMatchObject({ status: "done", person: "liz" });
      expect(names(m.state, "2026-11-16")).toEqual(["francisco", "lea", "liz", "mark"]);
    });

    it("rollover is safe to run twice", async () => {
      await cron(a, "/internal/rollover");
      const [{ n }] = await sql`select count(*)::int as n from week_history`;
      expect(n).toBe(4);
    });
  });

  describe("push subscriptions", () => {
    it("stores, reports and removes this device's subscription", async () => {
      const sub = {
        endpoint: "https://push.example.test/abc",
        keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" },
      };
      const headers = { cookie: lizCookie };
      expect((await fetch(a.url + "/api/push/subscribe", { method: "POST", headers, body: JSON.stringify(sub) })).status).toBe(201);
      const status = await (await fetch(`${a.url}/api/push/status?endpoint=${encodeURIComponent(sub.endpoint)}`, { headers })).json();
      expect(status.subscribed).toBe(true);
      await fetch(a.url + "/api/push/unsubscribe", { method: "POST", headers, body: JSON.stringify({ endpoint: sub.endpoint }) });
      const [{ n }] = await sql`select count(*)::int as n from push_subscriptions`;
      expect(n).toBe(0);
    });

    it("rejects a malformed subscription", async () => {
      const r = await fetch(a.url + "/api/push/subscribe", { method: "POST", headers: { cookie: lizCookie }, body: JSON.stringify({ endpoint: "nope" }) });
      expect(r.status).toBe(400);
    });
  });

  describe("restarts", () => {
    it("a phone reconnects to the other pod and catches up", async () => {
      mark.close();
      liz.send({ type: "checkoff", week: "2026-11-16", bin: "bio" });
      await liz.next("state", (x) => x.state.checkoffs.some((c) => c.week === "2026-11-16"));
      mark = await connect(a, markCookie);
      mark.send({ type: "hello", lastVersion: 0 });
      const m = await mark.next("state");
      expect(m.state.checkoffs.some((c) => c.week === "2026-11-16" && c.bin === "bio")).toBe(true);
    });
  });
});
