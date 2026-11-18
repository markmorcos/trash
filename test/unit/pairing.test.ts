import { describe, expect, it } from "vitest";
import { CODE_TTL_MS, chooseVersion, codeExpired, describeDisconnect, type WaVersion } from "../../whatsapp/pairing";

describe("link codes", () => {
  const t = 1_000_000;
  it("are valid for 3 minutes", () => {
    expect(codeExpired(t, t + CODE_TTL_MS, null)).toBe(false);
    expect(codeExpired(t, t + CODE_TTL_MS + 1, null)).toBe(true);
  });
  it("die with the connection that asked for them", () => {
    expect(codeExpired(t, t + 1000, t + 500)).toBe(true);
  });
  it("ignore a connection that closed before the code was issued", () => {
    expect(codeExpired(t, t + 1000, t - 500)).toBe(false);
  });
});

describe("WhatsApp Web version", () => {
  const bundled: WaVersion = [2, 3000, 1043857760];
  it("uses the current version when WhatsApp reports one", () => {
    expect(chooseVersion({ version: [2, 3000, 1055177075] }, bundled)).toEqual({ version: [2, 3000, 1055177075], source: "latest" });
  });
  it("falls back to the bundled one when the lookup fails or looks wrong", () => {
    expect(chooseVersion(null, bundled)).toEqual({ version: bundled, source: "bundled" });
    expect(chooseVersion({ version: [2, 3000] }, bundled).source).toBe("bundled");
    expect(chooseVersion({ version: [2, -1, 5] }, bundled).source).toBe("bundled");
  });
});

describe("disconnect reasons", () => {
  it("name the common ones with their code", () => {
    expect(describeDisconnect(401)).toBe("logged out on the phone (401)");
    expect(describeDisconnect(405)).toBe("rejected by WhatsApp (often an outdated client version) (405)");
    expect(describeDisconnect(999)).toBe("unexpected error (999)");
    expect(describeDisconnect(undefined)).toBe("unknown reason");
  });
});

import { LogRing, maskDigits, refusedMessage } from "../../whatsapp/pairing";

describe("troubleshooting details", () => {
  it("mask phone numbers and JIDs down to their last 3 digits", () => {
    expect(maskDigits("pair 491701234567@s.whatsapp.net ok")).toBe("pair •••567@s.whatsapp.net ok");
    expect(maskDigits("code 515 at 12:00")).toBe("code 515 at 12:00");
  });
  it("keep only the last lines, timestamped and masked", () => {
    const r = new LogRing(2);
    r.push("one", new Date("2026-11-18T15:00:01Z"));
    r.push("two 491701234567", new Date("2026-11-18T15:00:02Z"));
    r.push("three", new Date("2026-11-18T15:00:03Z"));
    expect(r.all()).toEqual(["15:00:02 two •••567", "15:00:03 three"]);
  });
  it("say why WhatsApp refused a code request", () => {
    expect(refusedMessage(Object.assign(new Error("bad-request"), { data: 400 }))).toBe("WhatsApp refused the code request (400 bad-request)");
    expect(refusedMessage(new Error("rate-overlimit"))).toBe("WhatsApp refused the code request (rate-overlimit)");
    expect(refusedMessage({})).toBe("WhatsApp refused the code request (no reason given)");
  });
});
