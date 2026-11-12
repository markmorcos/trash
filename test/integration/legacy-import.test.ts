// Upgrading the live database: before event sourcing the app kept current-state
// tables. On first start the server turns their rows into events with the
// original times and people, leaves the old tables alone, and never imports twice.
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assignWeek, type State } from "../../src/shared/rotation";
import { DEFAULT_CONFIG } from "../../src/shared/rotation";
import { resetDb } from "../support/reset-db.mjs";
import { loginAs, startPod, type Pod } from "../support/server";

const dbUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!dbUrl)("importing the old tables into events", () => {
  let sql: postgres.Sql;
  let pod: Pod;

  beforeAll(async () => {
    await resetDb(dbUrl);
    sql = postgres(dbUrl!, { max: 1, onnotice: () => {} });
    // the schema and rows as the live database has them today
    await sql.unsafe(`
      create table config (id int primary key default 1 check (id = 1), data jsonb not null, version int not null default 1, updated_at timestamptz not null default now());
      create table overrides (id uuid primary key default gen_random_uuid(), week date not null, kind text not null, person text not null, other text, created_by text not null, created_at timestamptz not null default now());
      create table checkoffs (week date not null, bin text not null, person text not null, done_by text not null, done_at timestamptz not null default now(), primary key (week, bin));
      create table week_history (week date not null, bin text not null, person text, status text not null, primary key (week, bin));
    `);
    await sql`insert into config (data, version, updated_at) values (${sql.json(DEFAULT_CONFIG as never)}, 7, '2026-11-11T23:20:00Z')`;
    await sql`insert into overrides (week, kind, person, other, created_by, created_at) values
      ('2026-11-09', 'away', 'mark', null, 'mark', '2026-11-11T23:20:01Z'),
      ('2026-12-28', 'away', 'mark', null, 'mark', '2026-11-12T10:00:00Z'),
      ('2026-11-16', 'away', 'ari', null, 'ari', '2026-11-12T11:00:00Z'),
      ('2026-11-23', 'swap', 'lea', 'liz', 'lea', '2026-11-12T12:00:00Z')`;
    await sql`insert into checkoffs (week, bin, person, done_by, done_at) values ('2026-11-09', 'rest', 'lea', 'lea', '2026-11-12T14:36:11Z')`;
    await sql`insert into week_history (week, bin, person, status) values
      ('2026-11-02', 'rest', 'liz', 'done'), ('2026-11-02', 'bio', 'ari', 'missed')`;
    pod = await startPod();
  });

  afterAll(async () => {
    await pod?.stop();
    await sql?.end();
  });

  it("turns every old row into an event, in time order, with who and when", async () => {
    const rows = await sql`select id::int as id, type, actor, at, data from events order by id`;
    expect(rows.map((r) => [r.type, r.actor])).toEqual([
      ["house.seeded", null],
      ["week.closed", null], // the old history row for 2 Nov, dated Monday 9 Nov when that week closed
      ["away.marked", "mark"],
      ["away.marked", "mark"],
      ["away.marked", "ari"],
      ["swap.made", "lea"],
      ["bin.taken_out", "lea"],
    ]);
    expect(new Date(rows[2].at).toISOString()).toBe("2026-11-11T23:20:01.000Z");
    expect(new Date(rows[6].at).toISOString()).toBe("2026-11-12T14:36:11.000Z");
    expect(rows[5].data).toMatchObject({ week: "2026-11-23", person: "lea", other: "liz" });
    expect(rows[1].data.bins).toEqual([
      { bin: "rest", person: "liz", status: "done", count: 1 },
      { bin: "bio", person: "ari", status: "missed", count: 0 },
    ]);
  });

  it("writes the whole import in a single transaction", async () => {
    const [{ n }] = await sql`select count(distinct xmin::text)::int as n from events`;
    expect(n).toBe(1);
  });

  it("rebuilds the same house the old tables described", async () => {
    const cookie = await loginAs(pod, "mark");
    const s = (await (await fetch(pod.url + "/api/state", { headers: { cookie } })).json()) as State;
    expect(s.version).toBe(7);
    expect(assignWeek(s.config, s.overrides, "2026-11-09").bins.map((b) => b.person)).toEqual(["lea", "liz", "francisco", "ari"]);
    expect(s.overrides.map((o) => [o.week, o.kind, o.person])).toEqual([
      ["2026-11-09", "away", "mark"],
      ["2026-12-28", "away", "mark"],
      ["2026-11-16", "away", "ari"],
      ["2026-11-23", "swap", "lea"],
    ]);
    expect(s.takeouts).toMatchObject([{ week: "2026-11-09", bin: "rest", person: "lea", at: "2026-11-12T14:36:11.000Z" }]);
    expect(s.history.map((h) => [h.week, h.bin, h.status])).toEqual([
      ["2026-11-02", "rest", "done"],
      ["2026-11-02", "bio", "missed"],
    ]);
    expect(s.activity[0].data.type).toBe("bin.taken_out");
  });

  it("leaves the old tables as they were", async () => {
    const [{ n }] = await sql`select count(*)::int as n from overrides`;
    const [{ v }] = await sql`select version as v from config`;
    expect([n, v]).toEqual([4, 7]);
  });

  it("imports only once, even after a restart", async () => {
    await pod.stop();
    pod = await startPod();
    const [{ n }] = await sql`select count(*)::int as n from events`;
    expect(n).toBe(7);
  });
});
