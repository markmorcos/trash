import { defineConfig, devices } from "@playwright/test";

const PORT = 8090;
const db = process.env.TEST_DATABASE_URL ?? "postgres://trash_app:dev@localhost:5433/trash_test";

export default defineConfig({
  testDir: "e2e",
  snapshotPathTemplate: "{testDir}/__screenshots__/{projectName}/{arg}{ext}",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  expect: {
    toHaveScreenshot: { threshold: 0.05, maxDiffPixels: 50, animations: "disabled", caret: "hide" },
  },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "off",
    timezoneId: "Europe/Berlin",
    locale: "en-GB",
  },
  projects: [
    { name: "phone-light", use: { ...devices["Pixel 7"], channel: "chromium", colorScheme: "light" } },
    { name: "phone-dark", use: { ...devices["Pixel 7"], channel: "chromium", colorScheme: "dark" } },
  ],
  webServer: {
    // fresh database every run: the server seeds the fridge state on start
    command: "node test/support/reset-db.mjs && node dist/server.js",
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      TEST_DATABASE_URL: db,
      DATABASE_URL: db,
      PORT: String(PORT),
      SESSION_SECRET: "visual-secret",
      CRON_TOKEN: "visual-cron",
      TRASH_TEST_MODE: "1",
      TRASH_FAKE_NOW: "2026-11-11T12:00:00+01:00",
      // throwaway keys for tests only, so the reminder toggle renders as in production
      VAPID_PUBLIC_KEY: "BDjKWRTECEJ_iyRuRcuxmOJykRWfzwu0PDeQtYSDiTXf5L2xvpplXcjFVR6n9mzhwIzm10SpoxyaE_xh8ACNt8g",
      VAPID_PRIVATE_KEY: "DyWivTX3YG1KA7cr1rXcPaKARgTvO5Xtb1u2gcx1ZHg",
      VAPID_SUBJECT: "https://trash.morcos.tech",
    },
  },
});
