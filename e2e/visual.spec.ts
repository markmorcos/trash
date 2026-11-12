// Screenshot tests for every screen, in light and dark, at phone size.
// The server's clock is pinned to Wed 11 Nov 2026 (week of 9 Nov: Mark away,
// Francisco covering Biomüll); the browser clock is pinned per test.
// None of these tests change data, so they can run in any order.
import { expect, test, type Page } from "@playwright/test";

const WED = new Date("2026-11-11T12:00:00+01:00");
const SUN = new Date("2026-11-15T17:00:00+01:00");

async function signIn(page: Page, person: string) {
  expect((await page.request.post("/api/me", { data: { person } })).ok()).toBe(true);
}

async function open(page: Page, hash: string, ready: string, at = WED) {
  await page.clock.setFixedTime(at);
  await page.goto("/#" + hash);
  await expect(page.getByRole("heading", { name: ready })).toBeVisible();
  await expect(page.locator(".offline")).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
}

// what other open test pages do must not change a screenshot
const masks = (page: Page) => [page.locator(".live"), page.getByTestId("conn-info")];

test.describe("joining", () => {
  test("a new device picks a name, no passcode", async ({ page }) => {
    await page.clock.setFixedTime(WED);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Who are you?" })).toBeVisible();
    await expect(page.locator("button.tile")).toHaveCount(5);
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveScreenshot("join-who.png");
  });

  test("picking a name opens this week and is remembered", async ({ page }) => {
    await page.clock.setFixedTime(WED);
    await page.goto("/");
    await page.getByRole("button", { name: /Liz/ }).click();
    await expect(page.getByRole("heading", { name: "Week 46" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Week 46" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Who are you?" })).toHaveCount(0);
  });

  test("switching person goes back to the picker", async ({ page }) => {
    await signIn(page, "mark");
    await open(page, "settings", "Settings");
    await page.getByRole("button", { name: "I'm not Mark" }).click();
    await expect(page.getByRole("heading", { name: "Who are you?" })).toBeVisible();
  });
});

test.describe("this week", () => {
  test("Liz: her bin, others pending", async ({ page }) => {
    await signIn(page, "liz");
    await open(page, "week", "Week 46");
    await expect(page.getByRole("button", { name: "I took it out" })).toHaveCount(1);
    await expect(page).toHaveScreenshot("week-liz.png", { fullPage: true, mask: masks(page) });
  });

  test("Francisco covering for Mark", async ({ page }) => {
    await signIn(page, "francisco");
    await open(page, "week", "Week 46");
    await expect(page.getByText("covering for Mark")).toBeVisible();
    await expect(page).toHaveScreenshot("week-francisco-covering.png", { fullPage: true, mask: masks(page) });
  });

  test("Mark away", async ({ page }) => {
    await signIn(page, "mark");
    await open(page, "week", "Week 46");
    await expect(page.getByText("You're marked away this week.")).toBeVisible();
    await expect(page.getByRole("button", { name: "I took it out" })).toHaveCount(0);
    await expect(page).toHaveScreenshot("week-mark-away.png", { fullPage: true, mask: masks(page) });
  });

  test("Sunday: bins due today", async ({ page }) => {
    await signIn(page, "ari");
    await open(page, "week", "Week 46", SUN);
    await expect(page.getByText("Sunday: every bin goes out today. 4 still pending.")).toBeVisible();
    await expect(page.getByText("Due today")).toHaveCount(4);
    await expect(page).toHaveScreenshot("week-sunday.png", { fullPage: true, mask: masks(page) });
  });
});

test.describe("upcoming", () => {
  test("eight weeks, my slot highlighted", async ({ page }) => {
    await signIn(page, "liz");
    await open(page, "upcoming", "Upcoming");
    await expect(page.locator("button.wk")).toHaveCount(8);
    await expect(page).toHaveScreenshot("upcoming.png", { fullPage: true, mask: masks(page) });
  });
});

test.describe("changes", () => {
  test("swap preview", async ({ page }) => {
    await signIn(page, "ari");
    await open(page, "changes", "Changes");
    await page.getByRole("button", { name: "23 Nov" }).click();
    await page.getByRole("button", { name: "Swap with…" }).click();
    await page.getByRole("button", { name: /Lea/ }).click();
    await expect(page.getByText("After: you →")).toBeVisible();
    await expect(page).toHaveScreenshot("changes-swap-preview.png", { fullPage: true, mask: masks(page) });
  });

  test("away preview: one person ends up with two bins", async ({ page }) => {
    await signIn(page, "liz");
    await open(page, "changes", "Changes");
    await page.getByRole("button", { name: "I'm away" }).click();
    await expect(page.getByText("Wertstoff → Francisco, who then has 2 bins")).toBeVisible();
    await expect(page).toHaveScreenshot("changes-away-two-bins.png", { fullPage: true, mask: masks(page) });
  });

  test("swap with someone who is away is blocked", async ({ page }) => {
    await signIn(page, "lea");
    await open(page, "changes", "Changes");
    await page.getByRole("button", { name: "Swap with…" }).click();
    await expect(page.getByRole("button", { name: /Mark/ })).toHaveCount(0);
    await expect(page).toHaveScreenshot("changes-swap-picker.png", { fullPage: true, mask: masks(page) });
  });
});

test.describe("settings", () => {
  test.use({ permissions: ["notifications"] });

  test("reminders, rotation and names", async ({ page }) => {
    await signIn(page, "mark");
    await open(page, "settings", "Settings");
    await expect(page.getByRole("switch", { name: "Reminders" })).toBeVisible();
    await expect(page).toHaveScreenshot("settings.png", { fullPage: true, mask: masks(page) });
  });

  test("reordering asks before changing it for everyone", async ({ page }) => {
    await signIn(page, "mark");
    await open(page, "settings", "Settings");
    await page.getByRole("button", { name: "Move Liz up" }).click();
    await expect(page.getByText("This changes the rotation for everyone")).toBeVisible();
    await expect(page).toHaveScreenshot("settings-reorder.png", { fullPage: true, mask: masks(page) });
  });

  test("notifications blocked in the browser", async ({ browser }) => {
    const ctx = await browser.newContext({ ...test.info().project.use, permissions: [] });
    await ctx.grantPermissions([]);
    const page = await ctx.newPage();
    await signIn(page, "mark");
    await open(page, "settings", "Settings");
    await expect(page.getByText("Notifications are blocked for this site")).toBeVisible();
    await expect(page).toHaveScreenshot("settings-notifications-blocked.png", { fullPage: true, mask: masks(page) });
    await ctx.close();
  });

  test("iPhone in Safari is told to add to the home screen", async ({ browser }) => {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      colorScheme: test.info().project.use.colorScheme,
    });
    const page = await ctx.newPage();
    await signIn(page, "lea");
    await open(page, "settings", "Settings");
    await expect(page.getByText("Add to Home Screen")).toBeVisible();
    await expect(page).toHaveScreenshot("settings-ios.png", { fullPage: true, mask: masks(page) });
    await ctx.close();
  });
});
