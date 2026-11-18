// The WhatsApp group card in Settings, through every state, against the bridge's
// fake connection. These tests tap buttons, so each starts from the seed.
import { expect, test, type Page } from "@playwright/test";
import { completeWhatsAppLink, open, resetHouse, signIn } from "./helpers";

test.beforeEach(async ({ page }) => resetHouse(page));
test.afterAll(async ({ browser }) => {
  const page = await browser.newPage({ baseURL: "http://127.0.0.1:8090" });
  await resetHouse(page);
  await page.close();
});

const card = (page: Page) => page.getByTestId("whatsapp-card");

/** Screenshot the card scrolled to the top, so the fixed tab bar never covers it. */
async function shot(page: Page, name: string) {
  await card(page).evaluate((el) => el.scrollIntoView({ block: "start" }));
  await expect(card(page)).toHaveScreenshot(name);
}

async function openSettings(page: Page) {
  await signIn(page, "mark");
  await open(page, "settings", "Settings");
  await expect(card(page)).toHaveAttribute("data-state", "unlinked");
}

test("not linked: explains what it does and asks for the number", async ({ page }) => {
  await openSettings(page);
  await expect(card(page)).toContainText("every take-out, away weeks and swaps, the Sunday reminder and Monday's new week");
  await expect(card(page).getByRole("button", { name: "Get link code" })).toBeDisabled();
  await shot(page, "whatsapp-unlinked.png");
});

test("link code with the steps to enter it", async ({ page }) => {
  await openSettings(page);
  await card(page).getByLabel("Your WhatsApp number").fill("+49 170 1234567");
  await card(page).getByRole("button", { name: "Get link code" }).click();
  await expect(page.getByTestId("wa-code")).toHaveText("TRSH-4CD9");
  await expect(card(page)).toContainText("Link with phone number instead");
  await shot(page, "whatsapp-code.png");
});

test("linked: pick the group, then it posts there", async ({ page }) => {
  await openSettings(page);
  await card(page).getByLabel("Your WhatsApp number").fill("+49 170 1234567");
  await card(page).getByRole("button", { name: "Get link code" }).click();
  await completeWhatsAppLink(page);
  await expect(card(page)).toHaveAttribute("data-state", "linked", { timeout: 10_000 });
  await expect(card(page)).toContainText("Linked as +49 ••• ••• 567");
  await expect(card(page).getByRole("button", { name: "🏠 Flat" })).toBeVisible();
  await shot(page, "whatsapp-pick-group.png");

  await card(page).getByRole("button", { name: "🏠 Flat" }).click();
  await expect(page.getByTestId("wa-target")).toContainText("Posting to 🏠 Flat");
  await expect(page.getByTestId("wa-target")).toContainText("Nothing posted yet");
  await shot(page, "whatsapp-active.png");

  // a test message goes out through the bridge
  await card(page).getByRole("button", { name: "Send test message" }).click();
  await expect(page.getByText("Test message queued")).toBeVisible();
  await expect(page.getByTestId("wa-target")).toContainText("Last post", { timeout: 20_000 });

  // the choice is in the Activity log
  await page.goto("/#activity");
  await expect(page.locator(".ev .txt").first()).toHaveText("Mark set WhatsApp posts to go to “🏠 Flat”");
});

test("turned off: says so and offers the groups again", async ({ page }) => {
  await openSettings(page);
  await card(page).getByLabel("Your WhatsApp number").fill("+49 170 1234567");
  await card(page).getByRole("button", { name: "Get link code" }).click();
  await completeWhatsAppLink(page);
  await card(page).getByRole("button", { name: "🏠 Flat" }).click({ timeout: 10_000 });
  await card(page).getByRole("button", { name: "Turn off" }).click();
  await expect(card(page)).toContainText("Posting is off. Pick a group to turn it back on.");
  await shot(page, "whatsapp-off.png");
});

test("unlinking asks first", async ({ page }) => {
  await openSettings(page);
  await card(page).getByLabel("Your WhatsApp number").fill("+49 170 1234567");
  await card(page).getByRole("button", { name: "Get link code" }).click();
  await completeWhatsAppLink(page);
  await card(page).getByRole("button", { name: "Unlink…" }).click({ timeout: 10_000 });
  await expect(card(page)).toContainText("Unlinking stops all posts");
  await card(page).getByRole("button", { name: "Unlink", exact: true }).click();
  await expect(card(page)).toHaveAttribute("data-state", "unlinked");
});
