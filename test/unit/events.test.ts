import { describe as group, expect, it } from "vitest";
import { apply, describe, emptyHouse, project, takeoutsFor, toState, type EventData, type HouseEvent } from "../../src/shared/events";
import { DEFAULT_CONFIG as C, assignWeek } from "../../src/shared/rotation";

let seq = 0;
const ev = (data: EventData, actor: string | null = "liz", at = "2026-11-11T10:00:00.000Z"): HouseEvent => ({ id: String(++seq), at, actor, data });
const seeded = () => {
  seq = 0;
  return [ev({ type: "house.seeded", config: C }, null)];
};
const W = "2026-11-09";

group("projection", () => {
  it("starts from the seed and counts versions by event id", () => {
    const h = project([...seeded(), ev({ type: "away.marked", week: W, person: "mark" }, "mark")]);
    expect(h.version).toBe(2);
    expect(h.config?.order).toEqual(C.order);
    expect(h.overrides).toMatchObject([{ id: "2", week: W, kind: "away", person: "mark", createdBy: "mark" }]);
  });

  it("keeps every take-out, so a bin can go out several times a week", () => {
    const h = project([
      ...seeded(),
      ev({ type: "bin.taken_out", week: W, bin: "wert", person: "liz" }, "liz", "2026-11-10T08:00:00.000Z"),
      ev({ type: "bin.taken_out", week: W, bin: "wert", person: "liz" }, "liz", "2026-11-12T19:30:00.000Z"),
      ev({ type: "bin.taken_out", week: W, bin: "rest", person: "lea" }, "lea"),
    ]);
    expect(takeoutsFor(h.takeouts, W, "wert").map((t) => t.at)).toEqual(["2026-11-10T08:00:00.000Z", "2026-11-12T19:30:00.000Z"]);
    expect(takeoutsFor(h.takeouts, W, "rest")).toHaveLength(1);
    expect(takeoutsFor(h.takeouts, W, "bio")).toHaveLength(0);
  });

  it("undoing a take-out removes only that one", () => {
    const evs = [
      ...seeded(),
      ev({ type: "bin.taken_out", week: W, bin: "wert", person: "liz" }),
      ev({ type: "bin.taken_out", week: W, bin: "wert", person: "liz" }),
    ];
    const h = project([...evs, ev({ type: "bin.take_out_undone", takeoutId: "3" })]);
    expect(takeoutsFor(h.takeouts, W, "wert").map((t) => t.id)).toEqual(["2"]);
  });

  it("away weeks and swaps feed the rotation, and undo removes them", () => {
    const evs = [
      ...seeded(),
      ev({ type: "away.marked", week: W, person: "mark" }, "mark"),
      ev({ type: "swap.made", week: W, person: "lea", other: "ari" }, "lea"),
    ];
    let h = project(evs);
    expect(assignWeek(h.config!, h.overrides, W).bins.map((b) => b.person)).toEqual(["ari", "liz", "francisco", "lea"]);
    h = project([...evs, ev({ type: "change.undone", changeId: "3" }, "lea")]);
    expect(assignWeek(h.config!, h.overrides, W).bins.map((b) => b.person)).toEqual(["lea", "liz", "francisco", "ari"]);
  });

  it("rotation and name changes bump the config revision", () => {
    const h = project([
      ...seeded(),
      ev({ type: "rotation.set", anchorWeek: "2026-11-16", order: ["liz", "lea", "mark", "ari", "francisco"] }),
      ev({ type: "people.renamed", names: { lea: "Lea M." } }),
    ]);
    expect(h.config).toMatchObject({ anchorWeek: "2026-11-16", order: ["liz", "lea", "mark", "ari", "francisco"], rev: 3 });
    expect(h.config!.people.find((p) => p.id === "lea")!.name).toBe("Lea M.");
  });

  it("closes a week only once, keeping counts", () => {
    const closed: EventData = { type: "week.closed", week: W, bins: [{ bin: "rest", person: "lea", status: "done", count: 2 }] };
    const h = project([...seeded(), ev(closed, null), ev(closed, null)]);
    expect(h.history).toEqual([{ week: W, bin: "rest", person: "lea", status: "done", count: 2 }]);
  });

  it("ignores events it has already applied, so overlapping batches are safe", () => {
    const evs = [...seeded(), ev({ type: "bin.taken_out", week: W, bin: "wert", person: "liz" })];
    const h = project(evs);
    project(evs, h);
    apply(h, evs[1]);
    expect(h.takeouts).toHaveLength(1);
    expect(h.version).toBe(2);
  });

  it("replaying the same events always gives the same house", () => {
    const evs = [
      ...seeded(),
      ev({ type: "away.marked", week: W, person: "mark" }, "mark"),
      ev({ type: "bin.taken_out", week: W, bin: "rest", person: "lea" }),
      ev({ type: "rotation.set", anchorWeek: W, order: ["lea", "liz", "mark", "ari", "francisco"] }),
    ];
    const a = project(evs);
    const b = project(structuredClone(evs));
    expect({ ...a, closed: [...a.closed] }).toEqual({ ...b, closed: [...b.closed] });
  });
});

group("state for phones", () => {
  it("sends only this and last week's take-outs and the recent activity", () => {
    const h = project([
      ...seeded(),
      ev({ type: "bin.taken_out", week: "2026-10-26", bin: "rest", person: "lea" }),
      ev({ type: "bin.taken_out", week: "2026-11-02", bin: "rest", person: "lea" }),
      ev({ type: "bin.taken_out", week: W, bin: "rest", person: "lea" }),
    ]);
    const s = toState(h, W, []);
    expect(s.version).toBe(4);
    expect(s.takeouts.map((t) => t.week)).toEqual(["2026-11-02", W]);
  });

  it("refuses to build state before the house is seeded", () => {
    expect(() => toState(emptyHouse(), W, [])).toThrow(/not been seeded/);
  });
});

group("activity sentences", () => {
  const evs = [
    ...seeded(),
    ev({ type: "away.marked", week: "2026-11-16", person: "mark" }, "mark"),
    ev({ type: "bin.taken_out", week: W, bin: "wert", person: "liz" }, "liz"),
    ev({ type: "swap.made", week: "2026-11-23", person: "ari", other: "lea" }, "ari"),
  ];
  const byId = new Map(evs.map((e) => [e.id, e]));
  const say = (data: EventData, actor: string | null = "liz") => describe(ev(data, actor), C, byId);

  it("names people and bins", () => {
    expect(describe(evs[0], C)).toBe("The rota started, matching the fridge");
    expect(describe(evs[1], C)).toBe("Mark is away the week of 16 Nov");
    expect(describe(evs[2], C)).toBe("Liz took out Wertstoff");
    expect(describe(evs[3], C)).toBe("Ari swapped with Lea for the week of 23 Nov");
  });

  it("says what an undo undid", () => {
    expect(say({ type: "change.undone", changeId: "2" }, "mark")).toBe("Mark undid Mark's away week (16 Nov)");
    expect(say({ type: "change.undone", changeId: "4" }, "lea")).toBe("Lea undid the swap Ari ⇄ Lea (23 Nov)");
    expect(say({ type: "bin.take_out_undone", takeoutId: "3" })).toBe("Liz undid a Wertstoff take-out");
    expect(say({ type: "change.undone", changeId: "999" })).toBe("Liz undid a change");
  });

  it("describes settings changes and closed weeks", () => {
    expect(say({ type: "rotation.set", anchorWeek: W, order: ["liz", "lea", "mark", "ari", "francisco"] })).toBe(
      "Liz changed the rotation from the week of 9 Nov: Liz, Lea, Mark, Ari, Francisco",
    );
    expect(say({ type: "people.renamed", names: { lea: "Lea M." } })).toBe("Liz changed names to Lea M.");
    expect(
      say({ type: "week.closed", week: W, bins: [{ bin: "rest", person: "lea", status: "done", count: 1 }, { bin: "bio", person: "francisco", status: "missed", count: 0 }] }, null),
    ).toBe("Week of 9 Nov closed · missed Biomüll");
    expect(say({ type: "week.closed", week: W, bins: [{ bin: "rest", person: "lea", status: "done", count: 3 }] }, null)).toBe(
      "Week of 9 Nov closed · every bin went out",
    );
  });
});
