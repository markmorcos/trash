// The server's idea of "now". Tests pin it (TRASH_FAKE_NOW) and move it
// (POST /internal/test/clock, only when TRASH_TEST_MODE=1). Production ignores both.
const testMode = process.env.TRASH_TEST_MODE === "1" && process.env.NODE_ENV !== "production";
let fake: Date | null = testMode && process.env.TRASH_FAKE_NOW ? new Date(process.env.TRASH_FAKE_NOW) : null;

export const isTestMode = () => testMode;
export const now = () => (fake ? new Date(fake) : new Date());
export function setNow(iso: string) {
  if (!testMode) throw new Error("clock is only adjustable in test mode");
  fake = new Date(iso);
}
