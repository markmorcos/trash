import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

const COOKIE = "trash_session";
const MAX_AGE = 90 * 24 * 3600;

let secret = process.env.SESSION_SECRET;
if (!secret) {
  secret = randomBytes(32).toString("hex");
  console.warn("SESSION_SECRET is not set: using a random one, sessions end on restart");
}

export interface Session {
  /** person id, or null after the passcode but before "who are you?" */
  p: string | null;
  iat: number;
}

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const sign = (v: string) => createHmac("sha256", secret!).update(v).digest("base64url");

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function sessionCookie(s: Session): string {
  const v = b64(JSON.stringify(s));
  return `${COOKIE}=${v}.${sign(v)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${
    process.env.NODE_ENV === "production" ? "; Secure" : ""
  }`;
}

export function readSession(req: IncomingMessage): Session | null {
  const raw = (req.headers.cookie ?? "")
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(COOKIE + "="));
  if (!raw) return null;
  const [v, sig] = raw.slice(COOKIE.length + 1).split(".");
  if (!v || !sig || !safeEqual(sig, sign(v))) return null;
  try {
    const s = JSON.parse(Buffer.from(v, "base64url").toString()) as Session;
    if (Date.now() / 1000 - s.iat > MAX_AGE) return null;
    return s;
  } catch {
    return null;
  }
}

export function checkPasscode(input: string): "ok" | "wrong" | "unset" {
  const pass = process.env.HOUSE_PASSCODE;
  if (!pass) return "unset";
  return safeEqual(input.trim(), pass) ? "ok" : "wrong";
}

const attempts = new Map<string, { n: number; reset: number }>();
/** 5 passcode tries per minute per IP. */
export function rateLimited(ip: string): boolean {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || a.reset < now) {
    attempts.set(ip, { n: 1, reset: now + 60_000 });
    return false;
  }
  a.n++;
  return a.n > 5;
}

export function clientIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  return (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0].trim() || req.socket.remoteAddress || "?";
}
