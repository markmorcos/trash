import { BIN_LABELS, addWeeks, assignWeek, binsOf, currentWeek, type Override } from "../shared/rotation";
import { loadConfig, mutate, sql } from "./db";
import { pushTo } from "./push";

async function overridesFor(week: string): Promise<Override[]> {
  const rows = await sql`select id, to_char(week, 'YYYY-MM-DD') as week, kind, person, other, created_by
    from overrides where week = ${week} order by created_at`;
  return rows.map((r) => ({ id: r.id, week: r.week, kind: r.kind, person: r.person, other: r.other, createdBy: r.created_by }));
}

/** Claim a notification slot; false if it was already sent (makes jobs safe to re-run). */
async function claim(week: string, kind: string, person: string): Promise<boolean> {
  const r = await sql`insert into notifications_sent (week, kind, person) values (${week}, ${kind}, ${person})
    on conflict do nothing returning person`;
  return r.length > 0;
}

const list = (xs: string[]) => (xs.length > 1 ? xs.slice(0, -1).join(", ") + " and " + xs.at(-1) : xs[0]);

/** Sunday evening: remind everyone whose bin is not ticked yet. */
export async function remind(now = new Date()) {
  const { config } = await loadConfig();
  const week = currentWeek(now, config.timezone);
  const a = assignWeek(config, await overridesFor(week), week);
  const done = new Set((await sql`select bin from checkoffs where week = ${week}`).map((r) => r.bin));
  const pending = new Map<string, string[]>();
  for (const b of a.bins) {
    if (b.person && !done.has(b.bin)) pending.set(b.person, [...(pending.get(b.person) ?? []), BIN_LABELS[b.bin]]);
  }
  const result: Record<string, number | "already sent"> = {};
  for (const [person, bins] of pending) {
    if (!(await claim(week, "remind", person))) {
      result[person] = "already sent";
      continue;
    }
    result[person] = await pushTo(person, {
      title: "Sunday: bins out tonight",
      body: `${list(bins)} still ${bins.length > 1 ? "need" : "needs"} to go out.`,
      tag: `remind-${week}`,
      url: "/#week",
    });
  }
  return { week, pending: Object.fromEntries(pending), sent: result };
}

/** Monday just after midnight: close last week into history and announce the new one. */
export async function rollover(now = new Date()) {
  const { config } = await loadConfig();
  const week = currentWeek(now, config.timezone);
  const last = addWeeks(week, -1);
  const a = assignWeek(config, await overridesFor(last), last);
  const done = new Set((await sql`select bin from checkoffs where week = ${last}`).map((r) => r.bin));
  const tracked = !config.since || last >= config.since;
  if (tracked) await mutate(async (tx) => {
    for (const b of a.bins) {
      await tx`insert into week_history (week, bin, person, status)
        values (${last}, ${b.bin}, ${b.person}, ${done.has(b.bin) ? "done" : "missed"})
        on conflict (week, bin) do nothing`;
    }
  });
  const next = assignWeek(config, await overridesFor(week), week);
  const sent: Record<string, number | "already sent"> = {};
  for (const p of config.people) {
    if (next.away.includes(p.id)) continue;
    if (!(await claim(week, "newweek", p.id))) {
      sent[p.id] = "already sent";
      continue;
    }
    const bins = binsOf(next, p.id).map((b) => BIN_LABELS[b]);
    sent[p.id] = await pushTo(p.id, {
      title: "New week",
      body: bins.length ? `You have ${list(bins)} this week.` : "You're on break this week. Enjoy.",
      tag: `newweek-${week}`,
      url: "/#week",
    });
  }
  const missed = tracked ? a.bins.filter((b) => !done.has(b.bin)).map((b) => b.bin) : [];
  return { closed: last, missed, week, sent };
}
