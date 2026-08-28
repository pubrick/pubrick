import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Applies migrations once for the whole run instead of once per e2e file — see the
    // comment in vitest.global-setup.ts for the flake this removes.
    globalSetup: ["./vitest.global-setup.ts"],
    // Six *.e2e.spec.ts files each bootstrap a full Nest app (module compile + better-auth
    // init) against one real Postgres. Left at the default (one worker per file, up to the
    // CPU count), all six raced for the CPU at once and blew the 10s hook timeout on most
    // runs — measured, not assumed; see the fix commit. Capping workers bounds how many of
    // those bootstraps run at once instead of hiding the contention behind a bigger timeout.
    maxWorkers: 2,
  },
  plugins: [swc.vite({ module: { type: "es6" } })],
});
