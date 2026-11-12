// End-to-end through the real server: HTTP API, WebSockets, Postgres LISTEN/NOTIFY
// across two server processes (like two pods during a rolling deploy), and the
// scheduled jobs. Needs TEST_DATABASE_URL pointing at a disposable database.
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assignWeek, lineupNotes, type State } from "../../src/shared/rotation";
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

    it("Settings notes from the live state show Mark away and Francisco covering", async () => {
      const s = (await (await fetch(a.url + "/api/state", { headers: { cookie: lizCookie } })).json()) as State;
      const notes = lineupNotes(s.config, s.overrides, WEEK);
      expect(notes.find((n) => n.person === "mark")).toMatchObject({ away: true, coveredBy: "francisco" });
      expect(notes.find((n) => n.person === "francisco")).toMatchObject({ away: false, actually: ["bio"] });
      expect(notes.filter((n) => n.away || n.actually).map((n) => n.person).sort()).toEqual(["francisco", "mark"]);
    });

    it("seeds only once even with two pods starting", async () => {
      const rows = await sql`select type, actor from events order by id`;
      expect(rows.map((r) => r.type)).toEqual(["house.seeded", "away.marked"]);
      expect(rows[1].actor).toBe("mark");
    });

    it("writes the seed in a single transaction", async () => {
      // every row inserted by one transaction shares its xmin
      const [{ n }] = await sql`select count(distinct xmin::text)::int as n from events`;
      expect(n).toBe(1);
    });

    it("the version is the latest event number", async () => {
      const s = (await (await fetch(a.url + "/api/state", { headers: { cookie: lizCookie } })).json()) as State;
      const [{ max }] = await sql`select max(id)::int as max from events`;
      expect(s.version).toBe(max);
      expect(s.activity.map((e) => e.data.type)).toEqual(["away.marked", "house.seeded"]);
    });

    it("events can't be changed or deleted", async () => {
      await expect(sql`update events set actor = 'eve' where id = 1`).rejects.toThrow(/append-only/);
      await expect(sql`delete from events where id = 1`).rejects.toThrow(/append-only/);
    });
  });

  describe("auth", () => {
    it("lists the house for a new device without any passcode", async () => {
      const s = await (await fetch(a.url + "/api/session")).json();
      expect(s.person).toBeNull();
      expect(s.people.map((p: { id: string }) => p.id)).toEqual(["lea", "liz", "mark", "ari", "francisco"]);
      // the old passcode login is gone
      expect([401, 404]).toContain((await fetch(a.url + "/api/login", { method: "POST", body: "{}" })).status);
    });

    it("picking a name is enough, and the device remembers it", async () => {
      const cookie = await loginAs(a, "ari");
      const s = await (await fetch(a.url + "/api/session", { headers: { cookie } })).json();
      expect(s.person).toBe("ari");
      expect((await fetch(a.url + "/api/state", { headers: { cookie } })).status).toBe(200);
    });

    it("needs a chosen person for the API and the socket", async () => {
      expect((await fetch(a.url + "/api/state")).status).toBe(401);
      expect(await tryConnect(a)).toBe(401);
      const out = await fetch(a.url + "/api/me", { method: "POST", headers: { cookie: lizCookie }, body: JSON.stringify({ person: null }) });
      const signedOut = out.headers.get("set-cookie")!.split(";")[0];
      expect(await tryConnect(a, signedOut)).toBe(401);
      expect((await fetch(a.url + "/api/state", { headers: { cookie: signedOut } })).status).toBe(401);
      expect(await tryConnect(a, lizCookie)).toBe(101);
    });

    it("rejects a forged cookie", async () => {
      const forged = "trash_session=" + Buffer.from(JSON.stringify({ p: "mark", iat: Date.now() / 1000 })).toString("base64url") + ".bad";
      expect((await fetch(a.url + "/api/state", { headers: { cookie: forged } })).status).toBe(401);
      expect(await tryConnect(a, forged)).toBe(401);
    });

    it("refuses unknown people", async () => {
      const r = await fetch(a.url + "/api/me", { method: "POST", body: JSON.stringify({ person: "eve" }) });
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
      const m = await mark.next("state", (x) => x.state.takeouts.some((c) => c.bin === "wert"));
      expect(m.state.takeouts.find((c) => c.bin === "wert")).toMatchObject({ person: "liz", week: WEEK });
    });

    it("a bin can go out several times a week, and undo removes only the latest", async () => {
      liz.send({ type: "checkoff", week: WEEK, bin: "wert" });
      let m = await mark.next("state", (x) => x.state.takeouts.filter((t) => t.bin === "wert").length === 2);
      const [first, second] = m.state.takeouts.filter((t) => t.bin === "wert");
      expect(Number(second.id)).toBeGreaterThan(Number(first.id));
      liz.send({ type: "uncheckoff", week: WEEK, bin: "wert" });
      m = await mark.next("state", (x) => x.state.takeouts.filter((t) => t.bin === "wert").length === 1);
      expect(m.state.takeouts.find((t) => t.bin === "wert")!.id).toBe(first.id);
      // the log keeps all three
      const types = (await sql`select type from events where type like 'bin.%' order by id`).map((r) => r.type);
      expect(types).toEqual(["bin.taken_out", "bin.taken_out", "bin.take_out_undone"]);
    });

    it("refuses undoing a take-out you didn't make", async () => {
      mark.send({ type: "uncheckoff", week: WEEK, bin: "wert" });
      expect((await mark.next("error")).code).toBe("not_found");
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
      const [row] = await sql`select id::text as id from events where type = 'swap.made'`;
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
      expect(m.state.history.find((h) => h.bin === "wert")).toMatchObject({ status: "done", person: "liz", count: 1 });
      expect(m.state.activity[0].data.type).toBe("week.closed");
      expect(names(m.state, "2026-11-16")).toEqual(["francisco", "lea", "liz", "mark"]);
    });

    it("past event #9, events still replay and list in number order (not text order)", async () => {
      const s = (await (await fetch(a.url + "/api/state", { headers: { cookie: lizCookie } })).json()) as State;
      const [{ max }] = await sql`select max(id)::int as max from events`;
      expect(max).toBeGreaterThan(10);
      expect(s.version).toBe(max);
      const ids = s.activity.map((e) => Number(e.id));
      expect(ids[0]).toBe(max);
      expect(ids).toEqual([...ids].sort((x, y) => y - x));
      // a fresh pod replaying everything from scratch reaches the same version and history
      const fresh = await startPod();
      try {
        const cookie = await loginAs(fresh, "liz");
        const t = (await (await fetch(fresh.url + "/api/state", { headers: { cookie } })).json()) as State;
        expect(t.version).toBe(max);
        expect(t.history).toEqual(s.history);
        expect(t.overrides).toEqual(s.overrides);
      } finally {
        await fresh.stop();
      }
    });

    it("rollover is safe to run twice", async () => {
      await cron(a, "/internal/rollover");
      const [{ n }] = await sql`select count(*)::int as n from events where type = 'week.closed'`;
      expect(n).toBe(1);
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
      await liz.next("state", (x) => x.state.takeouts.some((c) => c.week === "2026-11-16"));
      mark = await connect(a, markCookie);
      mark.send({ type: "hello", lastVersion: 0 });
      const m = await mark.next("state");
      expect(m.state.takeouts.some((c) => c.week === "2026-11-16" && c.bin === "bio")).toBe(true);
    });
  });
});
