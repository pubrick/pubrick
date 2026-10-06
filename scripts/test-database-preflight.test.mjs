import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { validateTestDatabase } from "./test-database-preflight.mjs";

test("database preflight accepts unit-only runs and canonical disposable loopback URLs", () => {
  for (const value of [
    undefined,
    "postgres://fixture@127.0.0.1:64375/pubrick_parity_test",
    "postgresql://fixture@localhost/pubrick_ci_test",
    "postgres://fixture@[::1]/pubrick_native_test",
  ]) {
    assert.doesNotThrow(() => validateTestDatabase(value));
  }
});
test("database preflight refuses malformed, retained and external database targets", () => {
  for (const value of [
    "",
    "invalid",
    "https://localhost/pubrick_ci_test",
    "postgres://localhost/pubrick",
    "postgres://localhost/pubrick_parity",
    "postgres://remote.example/pubrick_ci_test",
  ]) {
    assert.throws(() => validateTestDatabase(value), /loopback disposable/);
  }
});
test("database preflight CLI refuses before the suite without exposing credentials", () => {
  const result = spawnSync(process.execPath, ["scripts/test-database-preflight.mjs"], {
    encoding: "utf8",
    env: {
      ...process.env,
      TEST_DATABASE_URL: "postgres://private-user:private-password@remote.example/pubrick_ci_test",
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /loopback disposable/);
  assert.doesNotMatch(result.stderr, /private-user|private-password|remote\.example/);
});
