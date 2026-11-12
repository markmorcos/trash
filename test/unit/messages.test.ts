import { describe, expect, it } from "vitest";
import { ClientMessage } from "../../src/shared/messages";

const ok = (m: unknown) => ClientMessage.safeParse(m).success;

describe("client messages", () => {
  it("accepts every valid intent", () => {
    expect(ok({ type: "hello", lastVersion: 3 })).toBe(true);
    expect(ok({ type: "checkoff", week: "2026-11-09", bin: "wert" })).toBe(true);
    expect(ok({ type: "uncheckoff", week: "2026-11-09", bin: "papier" })).toBe(true);
    expect(ok({ type: "override", week: "2026-11-16", kind: "away" })).toBe(true);
    expect(ok({ type: "override", week: "2026-11-16", kind: "swap", with: "lea" })).toBe(true);
    expect(ok({ type: "undoOverride", id: "3f1c2b8e-1d2a-4c3b-9e8f-0a1b2c3d4e5f" })).toBe(true);
    expect(ok({ type: "updateConfig", baseRev: 1, lineup: ["a", "b"], names: { lea: "Lea M." } })).toBe(true);
  });

  it("rejects unknown types, bins and malformed fields", () => {
    expect(ok({ type: "dropTables" })).toBe(false);
    expect(ok({ type: "checkoff", week: "2026-11-09", bin: "glass" })).toBe(false);
    expect(ok({ type: "checkoff", week: "next monday", bin: "wert" })).toBe(false);
    expect(ok({ type: "override", week: "2026-11-16", kind: "forever" })).toBe(false);
    expect(ok({ type: "undoOverride", id: "1; drop table" })).toBe(false);
    expect(ok({ type: "updateConfig", baseRev: 1, names: { lea: "" } })).toBe(false);
    expect(ok({ type: "updateConfig", baseRev: 1, names: { lea: "x".repeat(31) } })).toBe(false);
  });
});
