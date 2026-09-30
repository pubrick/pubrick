import { fileURLToPath } from "node:url";
// No normal API global setup or DATABASE_URL: this tier owns a named disposable DB.
export default {
  root: fileURLToPath(new URL("../../", import.meta.url)),
  test: {
    include: ["apps/api/src/billing/billing.persistence.e2e.spec.ts"],
    maxWorkers: 1,
    testTimeout: 20000,
    hookTimeout: 120000,
  },
};
