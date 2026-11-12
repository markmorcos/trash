// "Install the app" instructions for each kind of device, in light and dark, plus
// how the card behaves: the real install prompt, the dismissible tip on This week,
// and hiding once the app runs installed.
import { expect, test, type Browser, type Page } from "@playwright/test";
import { masks, open, signIn } from "./helpers";

const UA = {
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  iphoneChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
  samsung:
    "Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
  androidFirefox: "Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0",
  desktopChrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  desktopFirefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
  instagram:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.0",
};
type Device = keyof typeof UA;
const phone = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const desktop = { viewport: { width: 1280, height: 800 } };

async function device(browser: Browser, name: Device, extra: { standalone?: boolean } = {}) {
  const ctx = await browser.newContext({
    ...(name.startsWith("desktop") || name === "macSafari" ? desktop : phone),
    deviceScaleFactor: 1,
    userAgent: UA[name],
    colorScheme: test.info().project.use.colorScheme,
    timezoneId: "Europe/Berlin",
    locale: "en-GB",
  });
  if (extra.standalone) {
    // pretend we were opened from the Home Screen
    await ctx.addInitScript(() => {
      const real = window.matchMedia.bind(window);
      window.matchMedia = (q: string) =>
        q.includes("display-mode: standalone") ? ({ ...real(q), matches: true, media: q, addEventListener() {} } as MediaQueryList) : real(q);
    });
  }
  return ctx;
}

/** Fire Chrome's install prompt the way the browser does, and record when the page uses it. */
async function offerInstallPrompt(page: Page, outcome: "accepted" | "dismissed" = "accepted") {
  await page.evaluate((outcome) => {
    const e = new Event("beforeinstallprompt", { cancelable: true }) as Event & Record<string, unknown>;
    e.prompt = async () => ((window as unknown as { __prompted: boolean }).__prompted = true);
    e.userChoice = Promise.resolve({ outcome });
    window.dispatchEvent(e);
  }, outcome);
}

const card = (page: Page) => page.getByTestId("install-card");

test.describe("instructions per device (Settings)", () => {
  const cases: [Device, string, RegExp][] = [
    ["iphoneSafari", "ios", /Add to Home Screen/],
    ["iphoneChrome", "ios-other", /Share button in the address bar/],
    ["androidChrome", "android-chrome", /⋮ menu/],
    ["samsung", "android-samsung", /Add page to/],
    ["androidFirefox", "android-firefox", /Add app to Home screen/],
    ["desktopChrome", "desktop-chromium", /install icon at the right end of the address bar/],
    ["macSafari", "desktop-safari", /File, then Add to Dock/],
    ["desktopFirefox", "desktop-firefox", /Pin Tab/],
    ["instagram", "in-app", /Open in browser/],
  ];
  for (const [name, platform, text] of cases) {
    test(`${name}`, async ({ browser }) => {
      const ctx = await device(browser, name);
      const page = await ctx.newPage();
      await signIn(page, "lea");
      await open(page, "settings", "Settings");
      await expect(card(page)).toHaveAttribute("data-platform", platform);
      await expect(card(page)).toContainText(text);
      await expect(card(page)).toHaveScreenshot(`install-${platform}.png`);
      await ctx.close();
    });
  }
});

test.describe("install button (Chrome / Edge)", () => {
  test("shows one Install button that opens the browser's own prompt", async ({ browser }) => {
    const ctx = await device(browser, "androidChrome");
    const page = await ctx.newPage();
    await signIn(page, "liz");
    await open(page, "settings", "Settings");
    await offerInstallPrompt(page);
    const button = card(page).getByRole("button", { name: "Install Trash" });
    await expect(button).toBeVisible();
    await expect(card(page).locator("ol")).toHaveCount(0);
    await expect(card(page)).toHaveScreenshot("install-button.png");
    await button.click();
    expect(await page.evaluate(() => (window as unknown as { __prompted?: boolean }).__prompted)).toBe(true);
    await expect(page.getByText("Installed")).toBeVisible();
    await expect(card(page)).toHaveCount(0);
    await ctx.close();
  });

  test("if the prompt is dismissed, the card falls back to the menu steps", async ({ browser }) => {
    const ctx = await device(browser, "androidChrome");
    const page = await ctx.newPage();
    await signIn(page, "liz");
    await open(page, "settings", "Settings");
    await offerInstallPrompt(page, "dismissed");
    await card(page).getByRole("button", { name: "Install Trash" }).click();
    await expect(card(page)).toContainText("⋮ menu");
    await expect(card(page).getByRole("button", { name: "Install Trash" })).toHaveCount(0);
    await ctx.close();
  });
});

test.describe("tip on This week", () => {
  test("shows once, and Got it hides it for good on this device", async ({ browser }) => {
    const ctx = await device(browser, "iphoneSafari");
    const page = await ctx.newPage();
    await signIn(page, "ari");
    await open(page, "week", "Week 46");
    await expect(card(page)).toContainText("Add to your Home Screen");
    await expect(page).toHaveScreenshot("week-install-tip.png", { fullPage: true, mask: masks(page) });
    await card(page).getByRole("button", { name: "Got it" }).click();
    await expect(card(page)).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Week 46" })).toBeVisible();
    await expect(card(page)).toHaveCount(0);
    // still available in Settings
    await page.goto("/#settings");
    await expect(card(page)).toBeVisible();
    await ctx.close();
  });
});

test.describe("already installed", () => {
  test("no install card anywhere when opened from the Home Screen", async ({ browser }) => {
    const ctx = await device(browser, "iphoneSafari", { standalone: true });
    const page = await ctx.newPage();
    await signIn(page, "mark");
    await open(page, "week", "Week 46");
    await expect(card(page)).toHaveCount(0);
    await page.goto("/#settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect(card(page)).toHaveCount(0);
    // and iPhone reminders are offered, because the Home Screen app can receive them
    await expect(page.getByText("reminders need the Home Screen app")).toHaveCount(0);
    await ctx.close();
  });
});
