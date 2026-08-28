import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
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
