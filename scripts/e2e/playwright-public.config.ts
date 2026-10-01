import { defineConfig } from "@playwright/test";

// biome-ignore lint/suspicious/noUndeclaredEnvVars: standalone read-only public-site acceptance, outside Turbo
const origin = process.env.PUBRICK_SITE_ORIGIN;
if (!origin || new URL(origin).hostname !== "127.0.0.1") {
  throw new Error("Public-site acceptance requires an explicit local PUBRICK_SITE_ORIGIN.");
}

export default defineConfig({
  testDir: ".",
  testMatch: "public-site.browser.ts",
  workers: 1,
  retries: 0,
  timeout: 120_000,
  outputDir: "../../.data/public-site-browser",
  reporter: "list",
  use: { baseURL: origin, browserName: "chromium", trace: "retain-on-failure" },
});
