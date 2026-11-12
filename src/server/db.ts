import postgres from "postgres";
import { emptyHouse, apply, toState, type EventData, type House, type HouseEvent } from "../shared/events";
import { DEFAULT_CONFIG, addDays, type Config, type State } from "../shared/rotation";
import { isTestMode, now } from "./clock";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

export const sql = postgres(url, { max: 5, idle_timeout: 30, onnotice: () => {} });

// The house is event-sourced: `events` is the only record of what happened and is
// append-only (a trigger refuses UPDATE and DELETE). Everything else is derived by
// replaying it. push_subscriptions and notifications_sent are device and delivery
// bookkeeping, not house state.
const SCHEMA = /* sql */ `
create table if not exists events (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor text,
  type text not null,
  data jsonb not null
);
create index if not exists events_type on events (type);
create or replace function events_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'events are append-only';
end $$;
create or replace trigger events_append_only before update or delete on events
  for each row execute function events_append_only();
create table if not exists push_subscriptions (
  endpoint text primary key,
  person text not null,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now()
);
create table if not exists notifications_sent (
  week date not null,
  kind text not null,
  person text not null,
  sent_at timestamptz not null default now(),
  primary key (week, kind, person)
);
`;

const MIGRATE_LOCK = 7311;
const APPEND_LOCK = 7312;

type Row = { id: string; at: Date; actor: string | null; data: EventData };
const toEvent = (r: Row): HouseEvent => ({ id: r.id, at: new Date(r.at).toISOString(), actor: r.actor, data: r.data });

/**
 * Schema, then the first events: an import of the old tables if this database
 * has them (keeping who did what and when), otherwise a fresh seed. Runs under
 * a lock so two pods starting together don't both seed.
 */
export async function migrate() {
  const c = await sql.reserve();
  try {
    await c`select pg_advisory_lock(${MIGRATE_LOCK})`;
    try {
      await c.unsafe(SCHEMA);
    } catch (e) {
      const [{ ok }] = await c`select to_regclass('public.events') is not null as ok`;
      if (!ok) {
        console.error("Can't create tables, and they don't exist yet. Grant this user CREATE on schema public, or run the schema once as an admin.");
        throw e;
      }
      console.warn("schema: no DDL permission, using existing tables");
    }
    const [{ n }] = await c`select count(*)::int as n from events`;
    if (n === 0) {
      const imported = await importLegacy(c);
      if (imported) console.log(`imported ${imported} events from the old tables`);
      // one transaction: a crash can't leave a half-seeded log that later starts would skip
      else await sql.begin((tx) => seed(tx));
    }
  } finally {
    await c`select pg_advisory_unlock(${MIGRATE_LOCK})`.catch(() => {});
    c.release();
  }
}

/** The fridge on 9 Nov 2026, Mark away that week. */
async function seed(q: postgres.Sql | postgres.ReservedSql | postgres.TransactionSql) {
  await insertAt(q, null, { type: "house.seeded", config: DEFAULT_CONFIG }, now());
  await insertAt(q, "mark", { type: "away.marked", week: "2026-11-09", person: "mark" }, now());
  console.log("seeded the house: the fridge on 9 Nov, Mark away that week");
}

/**
 * Test mode only: wipe the house back to the seed so screenshot tests that tap
 * buttons start from the same state. TRUNCATE skips the append-only row trigger;
 * nothing outside test mode can reach this.
 */
export async function resetForTests() {
  if (!isTestMode()) throw new Error("reset is only available in test mode");
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${APPEND_LOCK})`;
    await tx`truncate events, notifications_sent, push_subscriptions restart identity`;
    await seed(tx);
    await tx`select pg_notify('rota_changed', 'reset')`;
  });
  Object.assign(house, emptyHouse());
}

async function insertAt(q: postgres.Sql | postgres.ReservedSql | postgres.TransactionSql, actor: string | null, data: EventData, at: Date | null) {
  const [r] = at
    ? await q`insert into events (at, actor, type, data) values (${at}, ${actor}, ${data.type}, ${q.json(data as never)}) returning id::text as id, at`
    : await q`insert into events (actor, type, data) values (${actor}, ${data.type}, ${q.json(data as never)}) returning id::text as id, at`;
  return r as { id: string; at: Date };
}

/**
 * Before event sourcing the app kept current-state tables (config, overrides,
 * checkoffs, week_history). Turn their rows into events with their original
 * times and people, in time order. The old tables are left as they are.
 */
async function importLegacy(c: postgres.ReservedSql): Promise<number> {
  const [{ has }] = await c`select to_regclass('public.config') is not null as has`;
  if (!has) return 0;
  const [cfg] = await c`select data, updated_at from config where id = 1`;
  if (!cfg) return 0;
  const overrides = await c`select to_char(week, 'YYYY-MM-DD') as week, kind, person, other, created_by, created_at from overrides`;
  const checkoffs = await c`select to_char(week, 'YYYY-MM-DD') as week, bin, person, done_by, done_at from checkoffs`;
  const history = await c`select to_char(week, 'YYYY-MM-DD') as week, bin, person, status from week_history`;

  const items: { at: Date; actor: string | null; data: EventData }[] = [];
  for (const o of overrides)
    items.push({
      at: o.created_at,
      actor: o.created_by,
      data: o.kind === "swap" ? { type: "swap.made", week: o.week, person: o.person, other: o.other } : { type: "away.marked", week: o.week, person: o.person },
    });
  for (const t of checkoffs) items.push({ at: t.done_at, actor: t.done_by, data: { type: "bin.taken_out", week: t.week, bin: t.bin, person: t.person } });
  const byWeek = new Map<string, { bin: string; person: string | null; status: "done" | "missed" }[]>();
  for (const h of history) {
    const row = { bin: h.bin as string, person: h.person as string | null, status: h.status as "done" | "missed" };
    byWeek.set(h.week, [...(byWeek.get(h.week) ?? []), row]);
  }
  for (const [week, bins] of byWeek)
    items.push({
      // the rollover closes a week on the Monday after it
      at: new Date(addDays(week, 7) + "T00:05:00+01:00"),
      actor: null,
      data: { type: "week.closed", week, bins: bins.map((b) => ({ bin: b.bin as never, person: b.person, status: b.status, count: b.status === "done" ? 1 : 0 })) },
    });
  items.sort((a, b) => +a.at - +b.at);

  const firstAt = items.length ? new Date(+items[0].at - 1000) : new Date(cfg.updated_at);
  // one transaction on the pool; the caller's connection holds the migration lock meanwhile
  await sql.begin(async (tx) => {
    await insertAt(tx, null, { type: "house.seeded", config: cfg.data as Config }, firstAt);
    for (const it of items) await insertAt(tx, it.actor, it.data, it.at);
  });
  return items.length + 1;
}

// ---------- the projection, cached per process ----------

const house: House = emptyHouse();

/** Apply any events newer than what this process has seen. */
async function refresh(q: postgres.Sql | postgres.TransactionSql = sql) {
  const rows = (await q`select id::text as id, at, actor, data from events where events.id > ${house.version} order by events.id`) as unknown as Row[];
  for (const r of rows) apply(house, toEvent(r));
}

export async function loadHouse(): Promise<House> {
  await refresh();
  return house;
}

export async function loadConfig(): Promise<{ config: Config; version: number }> {
  const h = await loadHouse();
  if (!h.config) throw new Error("house has not been seeded");
  return { config: h.config, version: h.version };
}

export async function recentEvents(limit = 100): Promise<HouseEvent[]> {
  const rows = (await sql`select id::text as id, at, actor, data from events order by events.id desc limit ${limit}`) as unknown as Row[];
  return rows.map(toEvent);
}

export async function eventsById(ids: string[]): Promise<HouseEvent[]> {
  if (!ids.length) return [];
  const rows = (await sql`select id::text as id, at, actor, data from events where id in ${sql(ids)}`) as unknown as Row[];
  return rows.map(toEvent);
}

/** Everything a phone needs for this week, plus recent activity. */
export async function loadState(week: string): Promise<State> {
  const h = await loadHouse();
  const recent = await recentEvents();
  // undo events name what they undid, which may be older than the recent window
  const referenced = recent
    .map((e) => (e.data.type === "change.undone" ? e.data.changeId : e.data.type === "bin.take_out_undone" ? e.data.takeoutId : null))
    .filter((id): id is string => !!id && !recent.some((r) => r.id === id));
  const extra = await eventsById([...new Set(referenced)]);
  return toState(h, week, [...recent, ...extra.sort((a, b) => Number(b.id) - Number(a.id))]);
}

/**
 * Append events atomically. `decide` sees the house with every committed event
 * applied and returns the events to add (or throws to refuse). Appends are
 * serialized by an advisory lock, so decisions never race; every pod is told
 * with NOTIFY.
 */
export async function append(actor: string | null, decide: (h: House) => EventData[] | Promise<EventData[]>): Promise<HouseEvent[]> {
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${APPEND_LOCK})`;
    await refresh(tx);
    const datas = await decide(house);
    const out: HouseEvent[] = [];
    for (const d of datas) {
      // the server clock, so tests that pin time get stable event times
      const r = await insertAt(tx, actor, d, now());
      out.push({ id: r.id, at: new Date(r.at).toISOString(), actor, data: d });
    }
    if (out.length) await tx`select pg_notify('rota_changed', ${out[out.length - 1].id})`;
    return out;
  }) as Promise<HouseEvent[]>;
}
