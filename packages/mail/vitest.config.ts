import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: {
    alias: { "@pubrick/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)) },
  },
  test: { environment: "node", maxWorkers: 1 },
});
