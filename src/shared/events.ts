// Event sourcing: every change to the house is an append-only event. The current
// state is never stored; it is rebuilt by replaying the events in order
// (`project`). Pure code, shared by the server and the browser.
import {
  BIN_LABELS,
  BINS,
  addWeeks,
  type BinId,
  type Config,
  type HistoryRow,
  type Override,
  type State,
  type Takeout,
} from "./rotation";

export type EventData =
  /** First event: the house as it started (the fridge on 9 Nov 2026). */
  | { type: "house.seeded"; config: Config }
  | { type: "bin.taken_out"; week: string; bin: BinId; person: string }
  /** Removes one earlier take-out (a mistap). */
  | { type: "bin.take_out_undone"; takeoutId: string }
  | { type: "away.marked"; week: string; person: string }
  | { type: "swap.made"; week: string; person: string; other: string }
  /** Removes an earlier away week or swap. */
  | { type: "change.undone"; changeId: string }
  /** New base rotation from `anchorWeek` on. */
  | { type: "rotation.set"; anchorWeek: string; order: string[] }
  | { type: "people.renamed"; names: Record<string, string> }
  /** Written by the Monday rollover: how last week went, bin by bin. */
  | { type: "week.closed"; week: string; bins: { bin: BinId; person: string | null; status: "done" | "missed"; count: number }[] };

export type EventType = EventData["type"];

export interface HouseEvent {
  /** Sequence number as a string (bigint in Postgres). It is also the state version. */
  id: string;
  /** ISO time it happened */
  at: string;
  /** person id, or null for the system (rollover, import) */
  actor: string | null;
  data: EventData;
}

/** Everything the events add up to. */
export interface House {
  version: number;
  config: Config | null;
  overrides: Override[];
  takeouts: Takeout[];
  history: HistoryRow[];
  /** weeks already closed by a rollover */
  closed: Set<string>;
}

export const emptyHouse = (): House => ({ version: 0, config: null, overrides: [], takeouts: [], history: [], closed: new Set() });

/**
 * Apply one event. Mutates and returns `h`. Events at or below the current
 * version are ignored, so replaying an overlapping batch is harmless.
 */
export function apply(h: House, e: HouseEvent): House {
  const n = Number(e.id);
  if (n <= h.version) return h;
  h.version = n;
  const d = e.data;
  switch (d.type) {
    case "house.seeded":
      h.config = structuredClone(d.config);
      break;
    case "bin.taken_out":
      h.takeouts.push({ id: e.id, week: d.week, bin: d.bin, person: d.person, at: e.at });
      break;
    case "bin.take_out_undone":
      h.takeouts = h.takeouts.filter((t) => t.id !== d.takeoutId);
      break;
    case "away.marked":
      h.overrides.push({ id: e.id, week: d.week, kind: "away", person: d.person, other: null, createdBy: e.actor ?? d.person });
      break;
    case "swap.made":
      h.overrides.push({ id: e.id, week: d.week, kind: "swap", person: d.person, other: d.other, createdBy: e.actor ?? d.person });
      break;
    case "change.undone":
      h.overrides = h.overrides.filter((o) => o.id !== d.changeId);
      break;
    case "rotation.set":
      if (h.config) h.config = { ...h.config, anchorWeek: d.anchorWeek, order: [...d.order], rev: h.config.rev + 1 };
      break;
    case "people.renamed":
      if (h.config)
        h.config = {
          ...h.config,
          people: h.config.people.map((p) => (d.names[p.id] ? { ...p, name: d.names[p.id] } : p)),
          rev: h.config.rev + 1,
        };
      break;
    case "week.closed":
      if (h.closed.has(d.week)) break;
      h.closed.add(d.week);
      h.history.push(...d.bins.map((b) => ({ week: d.week, ...b })));
      break;
  }
  return h;
}

export function project(events: HouseEvent[], into: House = emptyHouse()): House {
  for (const e of events) apply(into, e);
  return into;
}

/** What a phone needs: config, overrides around now, this and last week's take-outs, recent history. */
export function toState(h: House, week: string, recent: HouseEvent[]): State {
  if (!h.config) throw new Error("house has not been seeded");
  const from = addWeeks(week, -8);
  const to = addWeeks(week, 26);
  return {
    version: h.version,
    config: h.config,
    overrides: h.overrides.filter((o) => o.week >= from && o.week <= to),
    takeouts: h.takeouts.filter((t) => t.week >= addWeeks(week, -1) && t.week <= week),
    // newest week first, bins in rotation order
    history: h.history
      .filter((r) => r.week >= from)
      .sort((a, b) => (a.week === b.week ? BINS.indexOf(a.bin) - BINS.indexOf(b.bin) : a.week < b.week ? 1 : -1)),
    activity: recent,
  };
}

/** Take-outs for one bin in one week, oldest first. */
export const takeoutsFor = (takeouts: Takeout[], week: string, bin: BinId) =>
  takeouts.filter((t) => t.week === week && t.bin === bin).sort((a, b) => Number(a.id) - Number(b.id));

const fmtWeek = (week: string) =>
  new Date(week + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/**
 * One plain sentence for the Activity tab. `config` gives names; `byId` lets an
 * undo name what it undid.
 */
export function describe(e: HouseEvent, config: Config | null, byId: Map<string, HouseEvent> = new Map()): string {
  const name = (id: string | null) => (id && config?.people.find((p) => p.id === id)?.name) || (id ?? "Someone");
  const who = e.actor ? name(e.actor) : "The app";
  const d = e.data;
  switch (d.type) {
    case "house.seeded":
      return "The rota started, matching the fridge";
    case "bin.taken_out":
      return `${name(d.person)} took out ${BIN_LABELS[d.bin]}`;
    case "bin.take_out_undone": {
      const t = byId.get(d.takeoutId)?.data;
      return t?.type === "bin.taken_out" ? `${who} undid a ${BIN_LABELS[t.bin]} take-out` : `${who} undid a take-out`;
    }
    case "away.marked":
      return `${name(d.person)} is away the week of ${fmtWeek(d.week)}`;
    case "swap.made":
      return `${name(d.person)} swapped with ${name(d.other)} for the week of ${fmtWeek(d.week)}`;
    case "change.undone": {
      const c = byId.get(d.changeId)?.data;
      if (c?.type === "away.marked") return `${who} undid ${name(c.person)}'s away week (${fmtWeek(c.week)})`;
      if (c?.type === "swap.made") return `${who} undid the swap ${name(c.person)} ⇄ ${name(c.other)} (${fmtWeek(c.week)})`;
      return `${who} undid a change`;
    }
    case "rotation.set":
      return `${who} changed the rotation from the week of ${fmtWeek(d.anchorWeek)}: ${d.order.map(name).join(", ")}`;
    case "people.renamed":
      // names are only known as they are now, so say what they became
      return `${who} changed names to ${Object.values(d.names).join(", ")}`;
    case "week.closed": {
      const missed = d.bins.filter((b) => b.status === "missed").map((b) => BIN_LABELS[b.bin]);
      return missed.length ? `Week of ${fmtWeek(d.week)} closed · missed ${missed.join(", ")}` : `Week of ${fmtWeek(d.week)} closed · every bin went out`;
    }
  }
}
