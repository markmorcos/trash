// Pure rules for linking with a phone-number code, and for which WhatsApp Web
// version to announce. Kept free of Baileys so they are unit-testable.

/** A link code is only good for a few minutes, and only on the connection that asked for it. */
export const CODE_TTL_MS = 3 * 60_000;
export const CODE_EXPIRED = "That code expired or didn't work. Get a new one.";

export function codeExpired(issuedAt: number, now: number, socketClosedAt: number | null): boolean {
  return now - issuedAt > CODE_TTL_MS || (socketClosedAt !== null && socketClosedAt >= issuedAt);
}

export type WaVersion = [number, number, number];

/** Prefer WhatsApp's current web version; an outdated one makes linking fail on the phone. */
export function chooseVersion(fetched: { version: number[] } | null, bundled: WaVersion): { version: WaVersion; source: "latest" | "bundled" } {
  const v = fetched?.version;
  if (Array.isArray(v) && v.length === 3 && v.every((n) => Number.isInteger(n) && n >= 0)) return { version: v as WaVersion, source: "latest" };
  return { version: bundled, source: "bundled" };
}

/** Disconnect status codes as WhatsApp/Baileys name them (no content, safe to show). */
const REASONS: Record<number, string> = {
  401: "logged out on the phone",
  403: "forbidden by WhatsApp",
  405: "rejected by WhatsApp (often an outdated client version)",
  408: "connection timed out",
  411: "multi-device mismatch",
  428: "connection closed",
  440: "replaced by another session",
  500: "bad session",
  503: "WhatsApp unavailable",
  515: "restart required",
};
export const describeDisconnect = (code: number | undefined) =>
  code === undefined ? "unknown reason" : `${REASONS[code] ?? "unexpected error"} (${code})`;

/**
 * Requesting a code writes `creds.me`. Reusing those credentials for another code makes
 * WhatsApp answer 401, so a new code needs a fresh session unless this one is untouched.
 */
export function needsFreshSession(creds: { me?: unknown; registered?: boolean }): boolean {
  return !!creds.me && !creds.registered;
}

/** Long digit runs (phone numbers, JIDs) shortened to their last 3 digits. */
export const maskDigits = (line: string) => line.replace(/\d{6,}/g, (d) => `•••${d.slice(-3)}`);

/** The last few library log lines, text only and masked, for the Settings card. */
export class LogRing {
  private lines: string[] = [];
  constructor(private size = 40) {}
  push(text: string, at = new Date()) {
    this.lines.push(`${at.toISOString().slice(11, 19)} ${maskDigits(text).slice(0, 200)}`);
    if (this.lines.length > this.size) this.lines.shift();
  }
  all() {
    return [...this.lines];
  }
  clear() {
    this.lines = [];
  }
}

/** What to tell people when WhatsApp refuses to hand out a link code. */
export function refusedMessage(err: unknown): string {
  const e = err as { message?: string; data?: unknown; output?: { statusCode?: number } };
  const code = typeof e?.data === "number" && Number.isFinite(e.data) ? e.data : null;
  const why = e?.message || "no reason given";
  return `WhatsApp refused the code request (${code ? `${code} ${why}` : why})`;
}
