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
