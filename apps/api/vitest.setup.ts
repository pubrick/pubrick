import { randomBytes } from "node:crypto";

// Some suites import the validated API environment before their own fixtures.
// Keep a unit-only run independent of operator secrets or a live database.
// TEST_DATABASE_URL remains unset unless the caller supplies an actual fixture;
// the database-tier guard still refuses its absence in CI.
process.env.DATABASE_URL ??=
  process.env.TEST_DATABASE_URL ?? "postgres://test:test@127.0.0.1:1/pubrick_unit_test";
process.env.BETTER_AUTH_SECRET ??= randomBytes(32).toString("hex");
process.env.APP_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
