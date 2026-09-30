import { fileURLToPath } from "node:url";

// Isolated pure-core tier: no API boot, database, SMTP or network.
const root = fileURLToPath(new URL("../../", import.meta.url));
export default {
  root,
  resolve: {
    alias: {
      "@pubrick/billing": `${root}/packages/billing/src/index.ts`,
      vitest: `${root}/packages/billing/node_modules/vitest/dist/index.js`,
    },
  },
  test: { include: ["apps/api/src/billing/*.spec.ts"], maxWorkers: 1 },
};
