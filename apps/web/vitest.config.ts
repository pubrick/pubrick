import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    // A timeout is a hang detector, not a load detector — the same reasoning
    // apps/api's config records, and the same 5 s default that caused it. A
    // hung `await` never returns, so 20 s catches it exactly as well; what 5 s
    // ALSO catches is a machine with something else on it, and this suite read
    // INCONCLUSIVE three times on 2026-09-05 that way, in files with nothing to
    // do with the change being measured. A gate that answers "maybe" under load
    // is not a gate.
    testTimeout: 20_000,
    hookTimeout: 30_000,
    // Aliased globally because vi.mock is hoisted per test file and cannot be
    // registered from a setup file. Every page would otherwise repeat the mock.
    alias: {
      "next/navigation": fileURLToPath(
        new URL("./src/test/next-navigation.stub.ts", import.meta.url),
      ),
      "@/lib/auth-client": fileURLToPath(
        new URL("./src/test/auth-client.stub.ts", import.meta.url),
      ),
    },
  },
});
