// Repeated take-outs and the Activity log. These tests tap buttons, so each one
// starts from the seed (test-only reset). Server and browser clocks are pinned to
// Wed 11 Nov 2026, 12:00 Berlin, so event times are stable.
import { expect, test, type Page } from "@playwright/test";
import { masks, open, resetHouse, signIn } from "./helpers";

test.beforeEach(async ({ page }) => resetHouse(page));
test.afterAll(async ({ browser }) => {
  // leave the house as the read-only screenshot specs expect
  const page = await browser.newPage();
  await resetHouse(page);
  await page.close();
});

const wert = (page: Page) => page.locator("article.bin", { has: page.getByRole("heading", { name: "Wertstoff" }) });

test("a bin can be taken out again when it fills up", async ({ page }) => {
  await signIn(page, "liz");
  await open(page, "week", "Week 46");
  await wert(page).getByRole("button", { name: "I took it out" }).click();
  await expect(page.getByTestId("out-wert")).toHaveText("Out ✓ Wed");
  await wert(page).getByRole("button", { name: "Took it out again" }).click();
  await expect(page.getByTestId("out-wert")).toHaveText("Out ×2 · last Wed");
  await expect(page.getByText("1/4 out")).toBeVisible();
  await expect(page).toHaveScreenshot("week-taken-out-twice.png", { fullPage: true, mask: masks(page) });
  // undo removes only the latest
  await wert(page).getByRole("button", { name: "Undo the last Wertstoff take-out" }).click();
  await expect(page.getByTestId("out-wert")).toHaveText("Out ✓ Wed");
});

test("Activity starts with the seed", async ({ page }) => {
  await signIn(page, "mark");
  await open(page, "activity", "Activity");
  await expect(page.getByTestId("day-2026-11-11")).toContainText("Today");
  await expect(page.locator(".ev")).toHaveCount(2);
  await expect(page.getByTestId("event-away.marked")).toContainText("Mark is away the week of 9 Nov");
  await expect(page.getByTestId("event-house.seeded")).toContainText("The rota started, matching the fridge");
  await expect(page).toHaveScreenshot("activity-seed.png", { fullPage: true, mask: masks(page) });
});

test("Activity lists every change, newest first, including undos", async ({ page }) => {
  // Liz takes Wertstoff out twice and undoes one
  await signIn(page, "liz");
  await open(page, "week", "Week 46");
  await wert(page).getByRole("button", { name: "I took it out" }).click();
  await wert(page).getByRole("button", { name: "Took it out again" }).click();
  await expect(page.getByTestId("out-wert")).toHaveText("Out ×2 · last Wed");
  await wert(page).getByRole("button", { name: "Undo the last Wertstoff take-out" }).click();
  await expect(page.getByTestId("out-wert")).toHaveText("Out ✓ Wed");
  // Ari marks 16 Nov away, then undoes it (a fresh page load, so the socket is Ari's)
  await signIn(page, "ari");
  await page.goto("about:blank");
  await open(page, "changes", "Changes");
  await page.getByRole("button", { name: "16 Nov" }).click();
  await page.getByRole("button", { name: "I'm away" }).click();
  await page.getByRole("button", { name: "Confirm away" }).click();
  await expect(page.getByText("16 Nov · 🍳 Ari away")).toBeVisible();
  await page.locator(".item", { hasText: "16 Nov · 🍳 Ari away" }).getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("16 Nov · 🍳 Ari away")).toHaveCount(0);

  await page.goto("/#activity");
  await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
  const lines = page.locator(".ev .txt");
  await expect(lines).toHaveText([
    "Ari undid Ari's away week (16 Nov)",
    "Ari is away the week of 16 Nov",
    "Liz undid a Wertstoff take-out",
    "Liz took out Wertstoff",
    "Liz took out Wertstoff",
    "Mark is away the week of 9 Nov",
    "The rota started, matching the fridge",
  ]);
  await expect(page.locator(".ev .n").first()).toHaveText("#7");
  await expect(page).toHaveScreenshot("activity-log.png", { fullPage: true, mask: masks(page) });
});
