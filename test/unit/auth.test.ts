import type { IncomingMessage } from "node:http";
import { beforeAll, describe, expect, it, vi } from "vitest";

type Auth = typeof import("../../src/server/auth");
let auth: Auth;

beforeAll(async () => {
  vi.stubEnv("SESSION_SECRET", "unit-test-secret");
  vi.stubEnv("HOUSE_PASSCODE", "4711");
  auth = await import("../../src/server/auth");
});

const req = (headers: Record<string, string>, remoteAddress = "10.0.0.1") =>
  ({ headers, socket: { remoteAddress } }) as unknown as IncomingMessage;
const cookieOf = (setCookie: string) => setCookie.split(";")[0];

describe("session cookie", () => {
  it("round-trips a signed session", () => {
    const c = auth.sessionCookie({ p: "liz", iat: Math.floor(Date.now() / 1000) });
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/SameSite=Lax/);
    expect(auth.readSession(req({ cookie: cookieOf(c) }))?.p).toBe("liz");
  });

  it("rejects a tampered session", () => {
    const c = cookieOf(auth.sessionCookie({ p: "liz", iat: Math.floor(Date.now() / 1000) }));
    const [name, value] = c.split("=");
    const [payload, sig] = value.split(".");
    const forged = Buffer.from(JSON.stringify({ p: "mark", iat: 1 })).toString("base64url");
    expect(auth.readSession(req({ cookie: `${name}=${forged}.${sig}` }))).toBeNull();
    expect(auth.readSession(req({ cookie: `${name}=${payload}.AAAA` }))).toBeNull();
  });

  it("rejects an expired session", () => {
    const old = Math.floor(Date.now() / 1000) - 91 * 24 * 3600;
    const c = cookieOf(auth.sessionCookie({ p: "liz", iat: old }));
    expect(auth.readSession(req({ cookie: c }))).toBeNull();
  });

  it("ignores other cookies and missing cookies", () => {
    expect(auth.readSession(req({}))).toBeNull();
    expect(auth.readSession(req({ cookie: "other=1; theme=dark" }))).toBeNull();
  });
});

describe("passcode", () => {
  it("accepts the right code, trims spaces, rejects others", () => {
    expect(auth.checkPasscode("4711")).toBe("ok");
    expect(auth.checkPasscode(" 4711 ")).toBe("ok");
    expect(auth.checkPasscode("1234")).toBe("wrong");
    expect(auth.checkPasscode("")).toBe("wrong");
  });

  it("allows 5 tries per minute per IP", () => {
    const ip = "192.0.2.9";
    const results = Array.from({ length: 6 }, () => auth.rateLimited(ip));
    expect(results).toEqual([false, false, false, false, false, true]);
    expect(auth.rateLimited("192.0.2.10")).toBe(false);
  });

  it("uses the first X-Forwarded-For address", () => {
    expect(auth.clientIp(req({ "x-forwarded-for": "203.0.113.5, 10.0.0.2" }))).toBe("203.0.113.5");
    expect(auth.clientIp(req({}, "10.1.2.3"))).toBe("10.1.2.3");
  });

  it("compares in constant time without throwing on length mismatch", () => {
    expect(auth.safeEqual("abc", "abc")).toBe(true);
    expect(auth.safeEqual("abc", "abcd")).toBe(false);
  });
});
