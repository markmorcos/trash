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

const bearer = { authorization: "Bearer visual-cron" };
export const BRIDGE = "http://127.0.0.1:8092";

/** Back to the seed (test mode only), for tests that tap buttons. Also unlinks the fake WhatsApp bridge. */
export async function resetHouse(page: Page) {
  const r = await page.request.post("/internal/test/reset", { headers: bearer });
  expect(r.ok()).toBe(true);
  expect((await page.request.post(BRIDGE + "/fake/reset", { headers: bearer })).ok()).toBe(true);
}

/** What entering the link code on the phone does, for the fake bridge. */
export async function completeWhatsAppLink(page: Page) {
  expect((await page.request.post(BRIDGE + "/fake/complete-link", { headers: bearer })).ok()).toBe(true);
}
