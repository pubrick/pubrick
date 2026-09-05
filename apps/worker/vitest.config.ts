import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
    globalSetup: ["./vitest.global-setup.ts"],
    // Keeps worker's own bootstrap-heavy publish.e2e.spec.ts from piling onto apps/api's
    // e2e files under turbo — see apps/api/vitest.config.ts for the measured flake.
    maxWorkers: 2,
    // Same reasoning as apps/api/vitest.config.ts: a timeout detects a hang,
    // not a busy machine.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
  plugins: [swc.vite({ module: { type: "es6" } })],
});
