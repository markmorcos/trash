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
