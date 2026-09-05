import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Applies migrations once for the whole run instead of once per e2e file — see the
    // comment in vitest.global-setup.ts for the flake this removes.
    globalSetup: ["./vitest.global-setup.ts"],
    // Every *.e2e.spec.ts file bootstraps a full Nest app (module compile + better-auth
    // init) against one real Postgres. Left at the default (one worker per file, up to the
    // CPU count), all six raced for the CPU at once and blew the 10s hook timeout on most
    // runs — measured, not assumed; see the fix commit. Capping workers bounds how many of
    // those bootstraps run at once instead of hiding the contention behind a bigger timeout.
    maxWorkers: 2,
    // A timeout is a hang detector, not a load detector: a hung `await` never
    // returns, so 20 s catches it as well as vitest's 5 s default does — and
    // 5 s is the number that turned three green gates red on 2026-09-05 when a
    // second checkout ran its own suite beside this one. 20 s is what the six
    // genuinely slow tests here had already picked by hand.
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // The two auth-posture defaults, turned off HERE rather than branched on inside
    // the auth config, so the divergence between the suite and the shipped image is
    // one visible list instead of a hidden `if (isTest)`:
    //  - the limiter caps sign-in/sign-up at 3 per 10s and, in test mode, better-auth
    //    keys every request on 127.0.0.1 — six e2e files signing up at once share one
    //    bucket and would 429 each other;
    //  - SIGNUP_MODE's default flips to invite-only the moment the first account
    //    exists, which is the second sign-up of the run.
    // Neither default goes untested: auth.compiled.e2e.spec.ts boots the compiled api
    // with these unset and asserts the 429s, and auth.e2e.spec.ts drives all three
    // postures by setting SIGNUP_MODE per test.
    env: { AUTH_RATE_LIMIT_ENABLED: "false", SIGNUP_MODE: "open" },
  },
  plugins: [swc.vite({ module: { type: "es6" } })],
});
