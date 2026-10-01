import { defineConfig } from "@playwright/test";

// biome-ignore lint/suspicious/noUndeclaredEnvVars: disposable runner-owned variables outside Turbo.
const origin = process.env.PUBRICK_E2E_ORIGIN;
// biome-ignore lint/suspicious/noUndeclaredEnvVars: disposable runner-owned marker.
const marker = process.env.PUBRICK_E2E_DISPOSABLE;
if (
  !marker?.startsWith("pubrick-browser-recurring-") ||
  !origin ||
  new URL(origin).hostname !== "127.0.0.1"
)
  throw new Error("Run node scripts/e2e/recurring.run.mjs");
export default defineConfig({
  testDir: ".",
  testMatch: "recurring-journey.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 8 * 60_000,
  outputDir: "../../.data/recurring-browser-tests",
  reporter: "list",
  use: {
    baseURL: origin,
    browserName: "chromium",
    timezoneId: "UTC",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
