import { defineConfig } from "@playwright/test";

// biome-ignore lint/suspicious/noUndeclaredEnvVars: owned disposable browser runner.
const origin = process.env.PUBRICK_E2E_ORIGIN;
// biome-ignore lint/suspicious/noUndeclaredEnvVars: owned disposable container marker.
const marker = process.env.PUBRICK_E2E_DISPOSABLE;
if (!marker?.startsWith("pubrick-browser-telegram-") || origin !== "https://127.0.0.1:31302")
  throw new Error("Run node scripts/e2e/telegram.run.mjs");
export default defineConfig({
  testDir: ".",
  testMatch: "telegram-journey.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 8 * 60_000,
  outputDir: "../../.data/telegram-browser-tests",
  reporter: "list",
  use: {
    baseURL: origin,
    browserName: "chromium",
    timezoneId: "UTC",
    // Only this disposable browser context trusts the runner's self-signed server.
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
