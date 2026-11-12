import postgres from "postgres";
import { DEFAULT_CONFIG, addWeeks, type Checkoff, type Config, type HistoryRow, type Override, type State } from "../shared/rotation";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

export const sql = postgres(url, { max: 5, idle_timeout: 30, onnotice: () => {} });

const SCHEMA = /* sql */ `
create table if not exists config (
  id int primary key default 1 check (id = 1),
  data jsonb not null,
  version int not null default 1,
  updated_at timestamptz not null default now()
);
create table if not exists overrides (
  id uuid primary key default gen_random_uuid(),
  week date not null,
  kind text not null check (kind in ('away', 'swap')),
  person text not null,
  other text,
  created_by text not null,
  created_at timestamptz not null default now()
);
create index if not exists overrides_week on overrides (week);
create table if not exists checkoffs (
  week date not null,
  bin text not null,
  person text not null,
  done_by text not null,
  done_at timestamptz not null default now(),
  primary key (week, bin)
);
create table if not exists week_history (
  week date not null,
  bin text not null,
  person text,
  status text not null check (status in ('done', 'missed')),
  primary key (week, bin)
);
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

/** Idempotent schema + first-run seed (the fridge as of 9 Nov 2026, Mark away that week). */
export async function migrate() {
  try {
    await sql.unsafe(SCHEMA);
  } catch (e) {
    // A least-privilege user may not be allowed DDL. That's fine once the tables exist.
    const [{ ok }] = await sql`select to_regclass('public.notifications_sent') is not null as ok`;
    if (!ok) {
      console.error("Can't create tables, and they don't exist yet. Grant this user CREATE on schema public, or run the schema once as an admin.");
      throw e;
    }
    console.warn("schema: no DDL permission, using existing tables");
  }
  await sql.begin(async (tx) => {
    const inserted = await tx`
      insert into config (id, data) values (1, ${tx.json(DEFAULT_CONFIG as never)})
      on conflict (id) do nothing returning id`;
    if (inserted.length) {
      await tx`insert into overrides (week, kind, person, created_by) values ('2026-11-09', 'away', 'mark', 'mark')`;
      console.log("seeded config and the 9 Nov away week");
    }
  });
}

const d = (v: Date | string) => (typeof v === "string" ? v.slice(0, 10) : v.toISOString().slice(0, 10));

export async function loadConfig(): Promise<{ config: Config; version: number }> {
  const [row] = await sql`select data, version from config where id = 1`;
  return { config: row.data as Config, version: row.version };
}

/** Everything a phone needs: config, overrides around now, recent check-offs and history. */
export async function loadState(week: string): Promise<State> {
  const from = addWeeks(week, -8);
  const to = addWeeks(week, 26);
  const [{ config, version }, ov, co, hist] = await Promise.all([
    loadConfig(),
    sql`select id, to_char(week, 'YYYY-MM-DD') as week, kind, person, other, created_by
        from overrides where week between ${from} and ${to} order by created_at`,
    sql`select to_char(week, 'YYYY-MM-DD') as week, bin, person, done_by, done_at
        from checkoffs where week between ${addWeeks(week, -1)} and ${week}`,
    sql`select to_char(week, 'YYYY-MM-DD') as week, bin, person, status
        from week_history where week >= ${from} order by week desc`,
  ]);
  return {
    version,
    config,
    overrides: ov.map(
      (r): Override => ({ id: r.id, week: r.week, kind: r.kind, person: r.person, other: r.other, createdBy: r.created_by }),
    ),
    checkoffs: co.map(
      (r): Checkoff => ({ week: r.week, bin: r.bin, person: r.person, doneBy: r.done_by, doneAt: new Date(r.done_at).toISOString() }),
    ),
    history: hist.map((r): HistoryRow => ({ week: r.week, bin: r.bin, person: r.person, status: r.status })),
  };
}

/** Run a mutation, bump the shared version and NOTIFY every pod in the same transaction. */
export async function mutate<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    const result = await fn(tx);
    const [{ version }] = await tx`update config set version = version + 1, updated_at = now() where id = 1 returning version`;
    await tx`select pg_notify('rota_changed', ${String(version)})`;
    return result;
  }) as Promise<T>;
}

export { d as dateOnly };
