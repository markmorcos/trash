// Pure rotation logic, shared by the browser and the server.
// Weeks are identified by their Monday as a calendar date ("YYYY-MM-DD") in the
// house timezone. All arithmetic is on calendar dates (UTC midnight), never on
// "7 × 24 hours", so DST changes cannot shift a rotation.

export const BINS = ["rest", "wert", "bio", "papier"] as const;
export type BinId = (typeof BINS)[number];

export const BIN_LABELS: Record<BinId, string> = {
  rest: "Restmüll",
  wert: "Wertstoff",
  bio: "Biomüll",
  papier: "Papier",
};

export interface Person {
  id: string;
  name: string;
  emoji: string;
  magnet: string;
}

export interface Config {
  timezone: string;
  /** Monday of the week where slot i belongs to order[i]. */
  anchorWeek: string;
  people: Person[];
  /** Person ids. First four take the bins in the anchor week, the rest rest. */
  order: string[];
  /** Bumped on every config edit; used to reject stale edits. */
  rev: number;
  /** First week the app tracked; earlier weeks never go into history. */
  since?: string;
}

export interface Override {
  id: string;
  week: string;
  kind: "away" | "swap";
  person: string;
  other: string | null;
  createdBy: string;
}

/** One time someone took a bin out. A bin can go out several times a week. */
export interface Takeout {
  /** id of the event that recorded it */
  id: string;
  week: string;
  bin: BinId;
  person: string;
  at: string;
}

export interface HistoryRow {
  week: string;
  bin: BinId;
  person: string | null;
  status: "done" | "missed";
  /** how many times it went out that week */
  count: number;
}

export interface State {
  /** id of the latest event */
  version: number;
  config: Config;
  overrides: Override[];
  takeouts: Takeout[];
  history: HistoryRow[];
  /** most recent events, newest first, for the Activity tab */
  activity: import("./events").HouseEvent[];
}

export interface BinAssignment {
  bin: BinId;
  /** Who takes it out this week. null if nobody is left to cover. */
  person: string | null;
  /** Set when person is covering for someone who is away. */
  covering: string | null;
}

export interface WeekAssignment {
  week: string;
  bins: BinAssignment[];
  /** People with no bin this week (normally one). */
  resting: string[];
  away: string[];
}

const DAY = 86_400_000;
const mod = (a: number, n: number) => ((a % n) + n) % n;

export function parseDate(d: string): number {
  const [y, m, day] = d.split("-").map(Number);
  return Date.UTC(y, m - 1, day);
}

export function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Calendar date ("YYYY-MM-DD") of an instant in a timezone. */
export function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}

/** 0 = Monday … 6 = Sunday */
export function weekday(date: string): number {
  return (new Date(parseDate(date)).getUTCDay() + 6) % 7;
}

export function mondayOf(date: string): string {
  return formatDate(parseDate(date) - weekday(date) * DAY);
}

export function currentWeek(at: Date, timeZone: string): string {
  return mondayOf(localDate(at, timeZone));
}

export function addWeeks(week: string, n: number): string {
  return formatDate(parseDate(week) + n * 7 * DAY);
}

export function addDays(date: string, n: number): string {
  return formatDate(parseDate(date) + n * DAY);
}

export function weeksBetween(from: string, to: string): number {
  return Math.round((parseDate(to) - parseDate(from)) / (7 * DAY));
}

export function isoWeekNumber(week: string): number {
  const ms = parseDate(week);
  const thursday = ms + 3 * DAY;
  const year = new Date(thursday).getUTCFullYear();
  const jan4 = Date.UTC(year, 0, 4);
  const week1 = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY;
  return 1 + Math.floor((thursday - week1) / (7 * DAY));
}

/** The rotation before any overrides: everyone shifts one slot right each week. */
export function baseLineup(config: Config, week: string): string[] {
  const n = weeksBetween(config.anchorWeek, week);
  const len = config.order.length;
  return config.order.map((_, i) => config.order[mod(i - n, len)]);
}

/**
 * Assignments for one week after overrides.
 * Swaps apply first (in creation order), then away weeks:
 * each vacated bin goes to a resting person first; once nobody is resting,
 * to the present person with the fewest bins, ties broken by the nearest slot
 * to the right. So one person can end up with several bins.
 */
export function assignWeek(config: Config, overrides: Override[], week: string): WeekAssignment {
  const lineup = baseLineup(config, week);
  const slots: (string | null)[] = lineup.slice(0, BINS.length);
  let resting = lineup.slice(BINS.length);
  const covering: (string | null)[] = BINS.map(() => null);
  const mine = overrides.filter((o) => o.week === week);

  for (const o of mine) {
    if (o.kind !== "swap" || !o.other) continue;
    const a = o.person;
    const b = o.other;
    const pos = (p: string) => {
      const s = slots.indexOf(p);
      return s >= 0 ? { kind: "bin" as const, i: s } : { kind: "rest" as const, i: resting.indexOf(p) };
    };
    const pa = pos(a);
    const pb = pos(b);
    if (pa.i < 0 || pb.i < 0) continue;
    const put = (p: { kind: "bin" | "rest"; i: number }, who: string) => {
      if (p.kind === "bin") slots[p.i] = who;
      else resting[p.i] = who;
    };
    put(pa, b);
    put(pb, a);
  }

  const away = [...new Set(mine.filter((o) => o.kind === "away").map((o) => o.person))].filter((p) =>
    lineup.includes(p),
  );
  resting = resting.filter((p) => !away.includes(p));

  // Reassign in the order people marked themselves away, so an earlier cover
  // never moves when someone else goes away later.
  const vacated: number[] = [];
  for (const p of away) {
    slots.forEach((s, i) => {
      if (s === p) {
        covering[i] = p;
        slots[i] = null;
        vacated.push(i);
      }
    });
  }

  for (const i of vacated) {
    if (resting.length) {
      slots[i] = resting.shift()!;
      continue;
    }
    const counts = new Map<string, number>();
    slots.forEach((p) => p && counts.set(p, (counts.get(p) ?? 0) + 1));
    let best: string | null = null;
    let bestCount = Infinity;
    for (let k = 1; k < BINS.length; k++) {
      const p = slots[(i + k) % BINS.length];
      if (!p) continue;
      const c = counts.get(p)!;
      if (c < bestCount) {
        best = p;
        bestCount = c;
      }
    }
    slots[i] = best;
  }

  return {
    week,
    bins: BINS.map((bin, i) => ({ bin, person: slots[i], covering: covering[i] })),
    resting,
    away,
  };
}

/** Which bins a person holds in a week (can be several, or none). */
export function binsOf(a: WeekAssignment, person: string): BinId[] {
  return a.bins.filter((b) => b.person === person).map((b) => b.bin);
}

export function nextRestWeek(config: Config, overrides: Override[], from: string, person: string): string | null {
  for (let i = 0; i < config.order.length * 3; i++) {
    const w = addWeeks(from, i);
    if (assignWeek(config, overrides, w).resting.includes(person)) return w;
  }
  return null;
}

export type OverrideError =
  | "unknown_person"
  | "already_away"
  | "not_on_rota"
  | "same_person"
  | "partner_away"
  | "already_swapped";

/** Validate a new override against the week as it stands. */
export function validateOverride(
  config: Config,
  overrides: Override[],
  week: string,
  kind: "away" | "swap",
  person: string,
  other: string | null,
): OverrideError | null {
  const ids = new Set(config.people.map((p) => p.id));
  if (!ids.has(person) || (kind === "swap" && (!other || !ids.has(other)))) return "unknown_person";
  const mine = overrides.filter((o) => o.week === week);
  const isAway = (p: string) => mine.some((o) => o.kind === "away" && o.person === p);
  if (!baseLineup(config, week).includes(person)) return "not_on_rota";
  if (kind === "away") return isAway(person) ? "already_away" : null;
  if (other === person) return "same_person";
  if (isAway(person)) return "already_away";
  if (isAway(other!)) return "partner_away";
  if (mine.some((o) => o.kind === "swap" && [o.person, o.other].some((p) => p === person || p === other)))
    return "already_swapped";
  return null;
}

export const DEFAULT_CONFIG: Config = {
  timezone: "Europe/Berlin",
  anchorWeek: "2026-11-09",
  people: [
    { id: "lea", name: "Lea", emoji: "🎂", magnet: "cake" },
    { id: "liz", name: "Liz", emoji: "☕", magnet: "teacup" },
    { id: "mark", name: "Mark", emoji: "🥧", magnet: "pie" },
    { id: "ari", name: "Ari", emoji: "🍳", magnet: "frying pan" },
    { id: "francisco", name: "Francisco", emoji: "🍷", magnet: "wine bottles" },
  ],
  order: ["lea", "liz", "mark", "ari", "francisco"],
  rev: 1,
  since: "2026-11-09",
};

export interface LineupNote {
  person: string;
  /** Slot in the base rotation this week: a bin, or null for a rest week. */
  baseBin: BinId | null;
  away: boolean;
  /** Who takes the base bin instead, when this person is away (null: nobody left). */
  coveredBy: string | null;
  /** Bins this person actually takes this week, when that differs from the base. */
  actually: BinId[] | null;
}

/**
 * How this week differs from the base rotation, per person in base order.
 * Settings edits the base order, so it shows that order plus these notes.
 */
export function lineupNotes(config: Config, overrides: Override[], week: string): LineupNote[] {
  const base = baseLineup(config, week);
  const actual = assignWeek(config, overrides, week);
  return base.map((person, i) => {
    const baseBin = i < BINS.length ? BINS[i] : null;
    const away = actual.away.includes(person);
    const mine = binsOf(actual, person);
    const same = baseBin ? mine.length === 1 && mine[0] === baseBin : mine.length === 0;
    return {
      person,
      baseBin,
      away,
      coveredBy: away && baseBin ? actual.bins[i].person : null,
      actually: away || same ? null : mine,
    };
  });
}
