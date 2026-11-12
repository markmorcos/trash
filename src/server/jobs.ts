import { takeoutsFor } from "../shared/events";
import { BIN_LABELS, addWeeks, assignWeek, binsOf, currentWeek } from "../shared/rotation";
import { now as clockNow } from "./clock";
import { append, loadHouse, sql } from "./db";
import { pushTo } from "./push";

/** Claim a notification slot; false if it was already sent (makes jobs safe to re-run). */
async function claim(week: string, kind: string, person: string): Promise<boolean> {
  const r = await sql`insert into notifications_sent (week, kind, person) values (${week}, ${kind}, ${person})
    on conflict do nothing returning person`;
  return r.length > 0;
}

const list = (xs: string[]) => (xs.length > 1 ? xs.slice(0, -1).join(", ") + " and " + xs.at(-1) : xs[0]);

/** Sunday evening: remind everyone with a bin that hasn't gone out at all this week. */
export async function remind(now = clockNow()) {
  const h = await loadHouse();
  const config = h.config!;
  const week = currentWeek(now, config.timezone);
  const a = assignWeek(config, h.overrides, week);
  const pending = new Map<string, string[]>();
  for (const b of a.bins) {
    if (b.person && takeoutsFor(h.takeouts, week, b.bin).length === 0)
      pending.set(b.person, [...(pending.get(b.person) ?? []), BIN_LABELS[b.bin]]);
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

/**
 * Monday just after midnight: close last week with a `week.closed` event (once;
 * re-runs add nothing) and announce the new week.
 */
export async function rollover(now = clockNow()) {
  const config = (await loadHouse()).config!;
  const week = currentWeek(now, config.timezone);
  const last = addWeeks(week, -1);
  const tracked = !config.since || last >= config.since;
  let missed: string[] = [];
  if (tracked) {
    await append(null, (h) => {
      if (h.closed.has(last)) return [];
      const a = assignWeek(h.config!, h.overrides, last);
      const bins = a.bins.map((b) => {
        const count = takeoutsFor(h.takeouts, last, b.bin).length;
        return { bin: b.bin, person: b.person, status: count > 0 ? ("done" as const) : ("missed" as const), count };
      });
      missed = bins.filter((b) => b.status === "missed").map((b) => b.bin);
      return [{ type: "week.closed", week: last, bins }];
    });
    if (!missed.length) {
      const closed = (await loadHouse()).history.filter((r) => r.week === last);
      missed = closed.filter((r) => r.status === "missed").map((r) => r.bin);
    }
  }
  const h = await loadHouse();
  const next = assignWeek(h.config!, h.overrides, week);
  const sent: Record<string, number | "already sent"> = {};
  for (const p of h.config!.people) {
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
  return { closed: last, missed, week, sent };
}
