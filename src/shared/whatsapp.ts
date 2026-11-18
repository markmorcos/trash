// What the flat's WhatsApp group is told, and when the bridge gives up on a post.
// Pure functions shared by the server (which queues posts) and the bridge (which sends them).
import { takeoutsFor, type EventData, type House } from "./events";
import { BIN_LABELS, addDays, assignWeek, binsOf, type Config } from "./rotation";

export type PostKind = "takeout" | "away" | "swap" | "undo" | "remind" | "newweek" | "test";
export interface Post {
  kind: PostKind;
  text: string;
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayMonth = (date: string) => {
  const [, m, d] = date.split("-").map(Number);
  return `${d} ${MON[m - 1]}`;
};
const weekRange = (week: string) => {
  const end = addDays(week, 6);
  return week.slice(5, 7) === end.slice(5, 7) ? `${Number(week.slice(8))}–${dayMonth(end)}` : `${dayMonth(week)} – ${dayMonth(end)}`;
};
const when = (week: string, current: string) => (week === current ? "this week" : `the week of ${dayMonth(week)}`);
const list = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : (xs[0] ?? ""));
const ordinal = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th"}`;

function names(c: Config) {
  const person = (id: string | null) => c.people.find((p) => p.id === id);
  return { name: (id: string | null) => person(id)?.name ?? "Someone", emoji: (id: string | null) => person(id)?.emoji ?? "👤" };
}

/**
 * Posts for events just appended. `before` is the house without them, `after`
 * with them. Take-out undos, settings and week closes post nothing.
 */
export function postsFor(events: EventData[], before: House, after: House, currentWeek: string): Post[] {
  const c = after.config;
  if (!c) return [];
  const { name, emoji } = names(c);
  const out: Post[] = [];
  for (const d of events) {
    switch (d.type) {
      case "bin.taken_out": {
        const n = takeoutsFor(after.takeouts, d.week, d.bin).length;
        out.push({
          kind: "takeout",
          text: n > 1 ? `🗑️ ${name(d.person)} took out ${BIN_LABELS[d.bin]} again (${ordinal(n)} time this week)` : `🗑️ ${name(d.person)} took out ${BIN_LABELS[d.bin]}`,
        });
        break;
      }
      case "away.marked": {
        const a = assignWeek(c, after.overrides, d.week);
        const covered = a.bins.filter((b) => b.covering === d.person);
        const head = `${emoji(d.person)} ${name(d.person)} is away ${when(d.week, currentWeek)}`;
        const tail = covered.length
          ? covered.map((b) => (b.person ? `${name(b.person)} covers ${BIN_LABELS[b.bin]}` : `nobody is left for ${BIN_LABELS[b.bin]}`)).join(", ")
          : "on break then anyway";
        out.push({ kind: "away", text: `${head} · ${tail}` });
        break;
      }
      case "swap.made": {
        const a = assignWeek(c, after.overrides, d.week);
        const has = (p: string) => list(binsOf(a, p).map((b) => BIN_LABELS[b])) || "a break";
        out.push({
          kind: "swap",
          text: `🔁 ${name(d.person)} and ${name(d.other)} swapped for ${when(d.week, currentWeek)} · ${name(d.person)} has ${has(d.person)}, ${name(d.other)} has ${has(d.other)}`,
        });
        break;
      }
      case "change.undone": {
        const o = before.overrides.find((x) => x.id === d.changeId);
        if (!o) break;
        out.push({
          kind: "undo",
          text:
            o.kind === "away"
              ? `↩️ ${name(o.person)} is back for ${when(o.week, currentWeek)}`
              : `↩️ The swap between ${name(o.person)} and ${name(o.other)} for ${when(o.week, currentWeek)} is off`,
        });
        break;
      }
    }
  }
  return out;
}

/** Sunday evening: which bins haven't gone out at all this week, and whose they are. */
export function sundayReminder(h: House, week: string): Post {
  const c = h.config!;
  const { name } = names(c);
  const pending = assignWeek(c, h.overrides, week).bins.filter((b) => takeoutsFor(h.takeouts, week, b.bin).length === 0);
  if (!pending.length) return { kind: "remind", text: "🎉 Sunday: all four bins are out. Thanks, everyone!" };
  const items = pending.map((b) => `${BIN_LABELS[b.bin]} (${b.person ? name(b.person) : "nobody"})`);
  return { kind: "remind", text: `⏰ Sunday: ${list(items)} still ${pending.length > 1 ? "need" : "needs"} to go out tonight.` };
}

/** Monday: the new week's rota, one line per bin. */
export function mondayRota(h: House, week: string): Post {
  const c = h.config!;
  const { name, emoji } = names(c);
  const a = assignWeek(c, h.overrides, week);
  const lines = a.bins.map((b) => {
    const who = b.person ? `${emoji(b.person)} ${name(b.person)}` : "nobody";
    return `${BIN_LABELS[b.bin]}: ${who}${b.covering ? ` (covering ${name(b.covering)})` : ""}`;
  });
  lines.push(`On break: ${a.resting.length ? a.resting.map((p) => `${emoji(p)} ${name(p)}`).join(", ") : "nobody"}`);
  if (a.away.length) lines.push(`Away: ${a.away.map(name).join(", ")}`);
  return { kind: "newweek", text: `📅 New week, ${weekRange(week)}\n${lines.join("\n")}` };
}

// ---------- sending policy (used by the bridge) ----------

export const MAX_ATTEMPTS = 5;
/** Posts older than this are dropped, so an outage never ends in a flood of stale news. */
export const EXPIRE_AFTER_MS = 12 * 3600_000;
/** Minimum gap between two posts. */
export const SEND_GAP_MS = 2000;

/** Wait before retry number `attempts` (1-based): 30 s, 1 min, 2 min, 4 min… capped at 30 min. */
export function backoffMs(attempts: number): number {
  return Math.min(30 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
}

export interface OutboxRow {
  createdAt: number;
  attempts: number;
  /** when the last attempt failed, if any */
  lastTriedAt: number | null;
}

export type NextStep = "send" | "wait" | "expire" | "fail";

export function nextStep(row: OutboxRow, now: number): NextStep {
  if (now - row.createdAt > EXPIRE_AFTER_MS) return "expire";
  if (row.attempts >= MAX_ATTEMPTS) return "fail";
  if (row.lastTriedAt !== null && now - row.lastTriedAt < backoffMs(row.attempts)) return "wait";
  return "send";
}
