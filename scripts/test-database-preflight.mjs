import { pathToFileURL } from "node:url";

/** Match native database specs before starting costly historical migration tests. */
export function validateTestDatabase(value) {
  if (value === undefined) return;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      "TEST_DATABASE_URL must be a loopback disposable PostgreSQL database named pubrick_*_test",
    );
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ||
    !/^\/pubrick_.*_test$/.test(parsed.pathname)
  ) {
    throw new Error(
      "TEST_DATABASE_URL must be a loopback disposable PostgreSQL database named pubrick_*_test",
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    validateTestDatabase(process.env.TEST_DATABASE_URL);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
