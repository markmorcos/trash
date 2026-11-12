import { describe, expect, it } from "vitest";
import { day, list, range } from "../../src/web/lib/format";

describe("formatting", () => {
  it("formats a day", () => {
    expect(day("2026-11-09")).toBe("9 Nov");
  });
  it("formats a week inside one month", () => {
    expect(range("2026-11-09")).toBe("9–15 Nov");
  });
  it("formats a week across two months and years", () => {
    expect(range("2026-11-30")).toBe("30 Nov – 6 Dec");
    expect(range("2026-12-28")).toBe("28 Dec – 3 Jan");
  });
  it("joins names in plain English", () => {
    expect(list([])).toBe("");
    expect(list(["Restmüll"])).toBe("Restmüll");
    expect(list(["Restmüll", "Papier"])).toBe("Restmüll and Papier");
    expect(list(["A", "B", "C"])).toBe("A, B and C");
  });
});
