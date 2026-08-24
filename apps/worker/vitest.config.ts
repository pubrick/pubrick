import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", setupFiles: ["./vitest.setup.ts"] },
  plugins: [swc.vite({ module: { type: "es6" } })],
});
