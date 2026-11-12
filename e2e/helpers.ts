import { expect, type Page } from "@playwright/test";

export const WED = new Date("2026-11-11T12:00:00+01:00");
export const SUN = new Date("2026-11-15T17:00:00+01:00");

export async function signIn(page: Page, person: string) {
  expect((await page.request.post("/api/me", { data: { person } })).ok()).toBe(true);
}

export async function open(page: Page, hash: string, ready: string, at = WED) {
  await page.clock.setFixedTime(at);
  await page.goto("/#" + hash);
  await expect(page.getByRole("heading", { name: ready })).toBeVisible();
  await expect(page.locator(".offline")).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
}

// what other open test pages do must not change a screenshot
export const masks = (page: Page) => [page.locator(".live"), page.getByTestId("conn-info")];

/** Back to the seed (test mode only), for tests that tap buttons. */
export async function resetHouse(page: Page) {
  const r = await page.request.post("/internal/test/reset", { headers: { authorization: "Bearer visual-cron" } });
  expect(r.ok()).toBe(true);
}
