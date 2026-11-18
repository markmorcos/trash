// The Baileys fixes in patches/ (applied on npm install) are present and behave as the
// upstream fixes intend. If an upgrade drops them, these fail before linking breaks.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleCompanionRegRefresh, makePairingQRRenderer, type AuthenticationCreds } from "@whiskeysockets/baileys";
import { needsFreshSession } from "../../whatsapp/pairing";

const lib = join(dirname(createRequire(import.meta.url).resolve("@whiskeysockets/baileys/package.json")), "lib");
const logger = { warn: vi.fn(), debug: vi.fn(), info: vi.fn() } as never;

describe("patched Baileys", () => {
  it("skips link_code_companion_reg without pairing data (#2602)", () => {
    expect(readFileSync(join(lib, "Socket/messages-recv.js"), "utf8")).toContain(
      "if (!getBinaryNodeChildBuffer(linkCodeCompanionReg, 'primary_identity_pub')) { break; }",
    );
  });

  it("acks before login without reading creds.me.id", () => {
    const src = readFileSync(join(lib, "Socket/messages-recv.js"), "utf8");
    expect(src).toContain("const meId = authState.creds.me?.id;");
    expect(src).not.toContain("buildAckStanza(node, errorCode, authState.creds.me.id)");
  });

  it("listens for companion_reg_refresh (#2765)", () => {
    expect(readFileSync(join(lib, "Socket/socket.js"), "utf8")).toContain("'CB:notification,type:companion_reg_refresh'");
  });

  it("rotates the adv secret on companion_reg_refresh while not yet linked", () => {
    const creds = { advSecretKey: "old" } as AuthenticationCreds;
    const emitCredsUpdate = vi.fn();
    const refreshQR = vi.fn();
    const node = { tag: "notification", attrs: { id: "1" }, content: [{ tag: "companion_reg_refresh", attrs: {} }] };
    expect(handleCompanionRegRefresh(node, { creds, emitCredsUpdate, refreshQR, logger })).toBe("rotated");
    expect(creds.advSecretKey).not.toBe("old");
    expect(emitCredsUpdate).toHaveBeenCalledWith({ advSecretKey: creds.advSecretKey });
    expect(refreshQR).toHaveBeenCalledOnce();
  });

  it("keeps the secret once linked, and ignores malformed notifications", () => {
    const linked = { advSecretKey: "keep", me: { id: "1@s.whatsapp.net" } } as AuthenticationCreds;
    const refresh = { tag: "notification", attrs: { id: "2" }, content: [{ tag: "companion_reg_refresh", attrs: {} }] };
    expect(handleCompanionRegRefresh(refresh, { creds: linked, emitCredsUpdate: vi.fn(), refreshQR: vi.fn(), logger })).toBe("ignored_registered");
    expect(linked.advSecretKey).toBe("keep");
    const odd = { tag: "notification", attrs: { id: "3" }, content: [{ tag: "something-else", attrs: {} }] };
    expect(handleCompanionRegRefresh(odd, { creds: { advSecretKey: "x" } as AuthenticationCreds, emitCredsUpdate: vi.fn(), refreshQR: vi.fn(), logger })).toBe(
      "ignored_malformed",
    );
  });

  it("re-renders the current QR ref without using up a new one", () => {
    const seen: string[] = [];
    const r = makePairingQRRenderer(["a", "b"], (ref) => seen.push(ref));
    expect(r.refresh()).toBe(false);
    expect(r.next()).toBe(true);
    expect(r.refresh()).toBe(true);
    expect(r.next()).toBe(true);
    expect(r.next()).toBe(false);
    expect(seen).toEqual(["a", "a", "b"]);
  });
});

describe("fresh session for a new code", () => {
  it("only after a code was requested on these credentials", () => {
    expect(needsFreshSession({})).toBe(false);
    expect(needsFreshSession({ me: { id: "49170…" }, registered: false })).toBe(true);
    expect(needsFreshSession({ me: { id: "49170…" }, registered: true })).toBe(false);
  });
});
