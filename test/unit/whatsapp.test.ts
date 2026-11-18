import { describe, expect, it } from "vitest";
import { project, type EventData, type HouseEvent } from "../../src/shared/events";
import { DEFAULT_CONFIG as C } from "../../src/shared/rotation";
import { EXPIRE_AFTER_MS, MAX_ATTEMPTS, backoffMs, mondayRota, nextStep, postsFor, sundayReminder } from "../../src/shared/whatsapp";

const W = "2026-11-09";
let seq = 0;
const ev = (data: EventData, actor: string | null = "liz"): HouseEvent => ({ id: String(++seq), at: "2026-11-11T10:00:00.000Z", actor, data });
function house(...data: EventData[]) {
  seq = 0;
  return project([ev({ type: "house.seeded", config: C }, null), ...data.map((d) => ev(d))]);
}
/** posts for `added` on top of the house built from `base` */
function posts(base: EventData[], added: EventData[], current = W) {
  const before = house(...base);
  const after = house(...base, ...added);
  return postsFor(added, before, after, current).map((p) => p.text);
}
const markAway: EventData = { type: "away.marked", week: W, person: "mark" };

describe("posts for events", () => {
  it("take-out, and a repeat counts the times", () => {
    const t: EventData = { type: "bin.taken_out", week: W, bin: "wert", person: "liz" };
    expect(posts([], [t])).toEqual(["🗑️ Liz took out Wertstoff"]);
    expect(posts([t], [t])).toEqual(["🗑️ Liz took out Wertstoff again (2nd time this week)"]);
    expect(posts([t, t], [t])).toEqual(["🗑️ Liz took out Wertstoff again (3rd time this week)"]);
  });

  it("away this week: who covers", () => {
    expect(posts([], [markAway])).toEqual(["🥧 Mark is away this week · Francisco covers Biomüll"]);
  });

  it("away another week, and the second person away doubles up a bin", () => {
    expect(posts([markAway], [{ type: "away.marked", week: W, person: "liz" }])).toEqual([
      "☕ Liz is away this week · Francisco covers Wertstoff",
    ]);
    expect(posts([], [{ type: "away.marked", week: "2026-11-23", person: "liz" }])).toEqual([
      "☕ Liz is away the week of 23 Nov · Mark covers Papier",
    ]);
  });

  it("away during a rest week", () => {
    expect(posts([], [{ type: "away.marked", week: W, person: "francisco" }])).toEqual(["🍷 Francisco is away this week · on break then anyway"]);
  });

  it("swap says who now has what", () => {
    expect(posts([], [{ type: "swap.made", week: "2026-11-23", person: "ari", other: "lea" }])).toEqual([
      "🔁 Ari and Lea swapped for the week of 23 Nov · Ari has Biomüll, Lea has Restmüll",
    ]);
  });

  it("undoing an away week or a swap", () => {
    expect(posts([markAway], [{ type: "change.undone", changeId: "2" }])).toEqual(["↩️ Mark is back for this week"]);
    expect(posts([{ type: "swap.made", week: "2026-11-23", person: "ari", other: "lea" }], [{ type: "change.undone", changeId: "2" }])).toEqual([
      "↩️ The swap between Ari and Lea for the week of 23 Nov is off",
    ]);
  });

  it("stays quiet for take-out undos, settings, renames and week closes", () => {
    const t: EventData = { type: "bin.taken_out", week: W, bin: "wert", person: "liz" };
    expect(
      posts(
        [t],
        [
          { type: "bin.take_out_undone", takeoutId: "2" },
          { type: "people.renamed", names: { lea: "Lea M." } },
          { type: "whatsapp.group_set", jid: "1@g.us", name: "Flat" },
          { type: "week.closed", week: "2026-11-02", bins: [] },
        ],
      ),
    ).toEqual([]);
  });
});

describe("scheduled posts", () => {
  it("Sunday lists the bins still out and whose they are", () => {
    const h = house(markAway, { type: "bin.taken_out", week: W, bin: "wert", person: "liz" });
    expect(sundayReminder(h, W).text).toBe("⏰ Sunday: Restmüll (Lea), Biomüll (Francisco) and Papier (Ari) still need to go out tonight.");
  });

  it("Sunday with one left uses 'needs'", () => {
    const h = house(...(["rest", "wert", "bio"] as const).map((bin) => ({ type: "bin.taken_out" as const, week: W, bin, person: "x" })));
    expect(sundayReminder(h, W).text).toBe("⏰ Sunday: Papier (Ari) still needs to go out tonight.");
  });

  it("Sunday with everything out says thanks", () => {
    const h = house(...(["rest", "wert", "bio", "papier"] as const).map((bin) => ({ type: "bin.taken_out" as const, week: W, bin, person: "x" })));
    expect(sundayReminder(h, W).text).toBe("🎉 Sunday: all four bins are out. Thanks, everyone!");
  });

  it("Monday lists the rota, covers, the break and who is away", () => {
    const h = house({ type: "away.marked", week: "2026-11-16", person: "mark" }, { type: "away.marked", week: "2026-11-16", person: "ari" });
    expect(mondayRota(h, "2026-11-16").text).toBe(
      [
        "📅 New week, 16–22 Nov",
        "Restmüll: 🍷 Francisco",
        "Wertstoff: 🎂 Lea",
        "Biomüll: ☕ Liz",
        "Papier: 🍷 Francisco (covering Mark)",
        "On break: nobody",
        "Away: Mark, Ari",
      ].join("\n"),
    );
  });

  it("Monday across two months, with someone on break", () => {
    expect(mondayRota(house(), "2026-11-30").text.split("\n").slice(0, 1).concat(mondayRota(house(), "2026-11-30").text.split("\n").slice(-1))).toEqual([
      "📅 New week, 30 Nov – 6 Dec",
      "On break: ☕ Liz",
    ]);
  });
});

describe("sending policy", () => {
  const now = 1_000_000_000_000;
  it("backs off 30 s, 1 min, 2 min… up to 30 min", () => {
    expect([1, 2, 3, 4, 10].map(backoffMs)).toEqual([30_000, 60_000, 120_000, 240_000, 1_800_000]);
  });
  it("sends new posts at once", () => {
    expect(nextStep({ createdAt: now, attempts: 0, lastTriedAt: null }, now)).toBe("send");
  });
  it("waits out the backoff after a failure, then retries", () => {
    expect(nextStep({ createdAt: now, attempts: 2, lastTriedAt: now }, now + 59_000)).toBe("wait");
    expect(nextStep({ createdAt: now, attempts: 2, lastTriedAt: now }, now + 60_000)).toBe("send");
  });
  it(`gives up after ${MAX_ATTEMPTS} failed attempts`, () => {
    expect(nextStep({ createdAt: now, attempts: MAX_ATTEMPTS, lastTriedAt: now }, now + 3_600_000)).toBe("fail");
  });
  it("expires posts older than 12 hours, even untried ones", () => {
    expect(nextStep({ createdAt: now, attempts: 0, lastTriedAt: null }, now + EXPIRE_AFTER_MS + 1)).toBe("expire");
  });
});
