import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG as C,
  assignWeek,
  baseLineup,
  currentWeek,
  isoWeekNumber,
  nextRestWeek,
  validateOverride,
  type Override,
} from "../../src/shared/rotation";

const ov = (o: Partial<Override>): Override => ({
  id: Math.random().toString(),
  week: "2026-11-09",
  kind: "away",
  person: "mark",
  other: null,
  createdBy: "mark",
  ...o,
});
const names = (a: ReturnType<typeof assignWeek>) => a.bins.map((b) => b.person);

describe("base rotation", () => {
  it("matches the fridge in the anchor week", () => {
    expect(baseLineup(C, "2026-11-09")).toEqual(["lea", "liz", "mark", "ari", "francisco"]);
  });
  it("shifts everyone one bin right each Monday", () => {
    expect(baseLineup(C, "2026-11-16")).toEqual(["francisco", "lea", "liz", "mark", "ari"]);
  });
  it("comes back after five weeks", () => {
    expect(baseLineup(C, "2026-12-14")).toEqual(baseLineup(C, "2026-11-09"));
  });
  it("works before the anchor too", () => {
    expect(baseLineup(C, "2026-11-02")).toEqual(["liz", "mark", "ari", "francisco", "lea"]);
  });
  it("gives each person one rest week in five", () => {
    expect(nextRestWeek(C, [], "2026-11-16", "ari")).toBe("2026-11-16");
    expect(nextRestWeek(C, [], "2026-11-16", "francisco")).toBe("2026-12-14");
  });
});

describe("Berlin weeks", () => {
  it("Sunday 23:59 Berlin is still the old week, Monday 00:00 the new one", () => {
    // 15 Nov 2026 23:59 CET = 22:59 UTC; 16 Nov 00:00 CET = 23:00 UTC on the 15th
    expect(currentWeek(new Date("2026-11-15T22:59:00Z"), "Europe/Berlin")).toBe("2026-11-09");
    expect(currentWeek(new Date("2026-11-15T23:00:00Z"), "Europe/Berlin")).toBe("2026-11-16");
  });
  it("is not shifted by daylight saving changes", () => {
    // DST starts 29 Mar 2027 02:00; Monday 29 Mar 00:30 CET = 28 Mar 23:30 UTC
    expect(currentWeek(new Date("2027-03-28T23:30:00Z"), "Europe/Berlin")).toBe("2027-03-29");
    // DST ends 25 Oct 2026; Monday 26 Oct 00:30 CET = 25 Oct 23:30 UTC
    expect(currentWeek(new Date("2026-10-25T23:30:00Z"), "Europe/Berlin")).toBe("2026-10-26");
    // 20 weeks after the anchor, across a DST change: back to the fridge lineup
    expect(baseLineup(C, "2027-03-29")).toEqual(baseLineup(C, "2026-11-09"));
  });
  it("numbers ISO weeks", () => {
    expect(isoWeekNumber("2026-11-09")).toBe(46);
    expect(isoWeekNumber("2026-12-28")).toBe(53);
  });
});

describe("overrides", () => {
  it("Mark away on 9 Nov: Francisco covers Biomüll", () => {
    const a = assignWeek(C, [ov({})], "2026-11-09");
    expect(names(a)).toEqual(["lea", "liz", "francisco", "ari"]);
    expect(a.bins[2].covering).toBe("mark");
    expect(a.resting).toEqual([]);
    expect(a.away).toEqual(["mark"]);
  });
  it("does not change the next week", () => {
    expect(names(assignWeek(C, [ov({})], "2026-11-16"))).toEqual(["francisco", "lea", "liz", "mark"]);
  });
  it("two people away: someone takes two bins", () => {
    const a = assignWeek(C, [ov({}), ov({ person: "lea" })], "2026-11-09");
    expect(a.bins.filter((b) => b.person === null)).toHaveLength(0);
    const counts = a.bins.reduce<Record<string, number>>((m, b) => ((m[b.person!] = (m[b.person!] ?? 0) + 1), m), {});
    expect(Object.values(counts).sort()).toEqual([1, 1, 2]);
    expect(a.away.sort()).toEqual(["lea", "mark"]);
  });
  it("an earlier cover stays put when a second person goes away", () => {
    const a = assignWeek(C, [ov({}), ov({ person: "liz" })], "2026-11-09");
    // Mark away first → Francisco on Bio. Liz away next → nearest to the right of Wertstoff is Francisco.
    expect(names(a)).toEqual(["lea", "francisco", "francisco", "ari"]);
    expect(a.bins[1].covering).toBe("liz");
  });
  it("nearest person to the right breaks ties", () => {
    const a = assignWeek(C, [ov({ person: "lea" }), ov({ person: "mark" })], "2026-11-09");
    // Restmüll (slot 0) vacated first → Francisco (resting). Bio (slot 2) → right of 2 is Ari.
    expect(names(a)).toEqual(["francisco", "liz", "ari", "ari"]);
  });
  it("resting person away changes nothing else", () => {
    const a = assignWeek(C, [ov({ person: "francisco" })], "2026-11-09");
    expect(names(a)).toEqual(["lea", "liz", "mark", "ari"]);
    expect(a.resting).toEqual([]);
  });
  it("swaps two people for one week", () => {
    const a = assignWeek(C, [ov({ kind: "swap", person: "ari", other: "lea", week: "2026-11-23" })], "2026-11-23");
    expect(baseLineup(C, "2026-11-23")).toEqual(["ari", "francisco", "lea", "liz", "mark"]);
    expect(names(a)).toEqual(["lea", "francisco", "ari", "liz"]);
  });
  it("swap with the resting person", () => {
    const a = assignWeek(C, [ov({ kind: "swap", person: "lea", other: "francisco" })], "2026-11-09");
    expect(names(a)).toEqual(["francisco", "liz", "mark", "ari"]);
    expect(a.resting).toEqual(["lea"]);
  });
  it("everyone away leaves bins unassigned", () => {
    const all = C.order.map((p) => ov({ person: p }));
    expect(names(assignWeek(C, all, "2026-11-09"))).toEqual([null, null, null, null]);
  });
});

describe("validation", () => {
  const existing = [ov({})];
  it("rejects a second away for the same person", () => {
    expect(validateOverride(C, existing, "2026-11-09", "away", "mark", null)).toBe("already_away");
  });
  it("rejects a swap with someone away", () => {
    expect(validateOverride(C, existing, "2026-11-09", "swap", "lea", "mark")).toBe("partner_away");
  });
  it("rejects swapping with yourself", () => {
    expect(validateOverride(C, [], "2026-11-09", "swap", "lea", "lea")).toBe("same_person");
  });
  it("rejects double swaps", () => {
    const s = [ov({ kind: "swap", person: "lea", other: "liz" })];
    expect(validateOverride(C, s, "2026-11-09", "swap", "liz", "ari")).toBe("already_swapped");
  });
  it("accepts a normal swap", () => {
    expect(validateOverride(C, [], "2026-11-09", "swap", "lea", "ari")).toBeNull();
  });
});
