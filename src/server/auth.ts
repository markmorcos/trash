import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

// No passcode: whoever has the link picks their name, and this signed cookie
// remembers the choice on that device.

const COOKIE = "trash_session";
const MAX_AGE = 90 * 24 * 3600;

let secret = process.env.SESSION_SECRET;
if (!secret) {
  secret = randomBytes(32).toString("hex");
  console.warn("SESSION_SECRET is not set: using a random one, sessions end on restart");
}

export interface Session {
  /** person id, or null after "I'm not …" until they pick again */
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
