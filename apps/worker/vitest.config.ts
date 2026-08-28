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
  },
  plugins: [swc.vite({ module: { type: "es6" } })],
});
