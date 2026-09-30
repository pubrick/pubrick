import { defineConfig } from "@playwright/test";

// biome-ignore lint/suspicious/noUndeclaredEnvVars: local browser runner is deliberately outside Turbo tasks.
const origin = process.env.PUBRICK_E2E_ORIGIN;
if (
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: local browser runner owns this marker.
  !process.env.PUBRICK_E2E_DISPOSABLE?.startsWith("pubrick-browser-") ||
  !origin ||
  new URL(origin).hostname !== "127.0.0.1"
) {
  throw new Error("Run node scripts/e2e/run.mjs; browser tests require its disposable stack.");
}
export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 60_000,
  outputDir: "../../.data/browser-tests",
  reporter: "list",
  use: {
    baseURL: origin,
    browserName: "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
