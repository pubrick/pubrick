import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("dev bootstrap applies configured ports and browser origin to native apps", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pubrick-init-test-"));
  try {
    copyFileSync(
      fileURLToPath(new URL("../init.sh", import.meta.url)),
      path.join(directory, "init.sh"),
    );
    const bin = path.join(directory, "bin");
    mkdirSync(bin);
    for (const app of ["api", "worker", "web"])
      mkdirSync(path.join(directory, "apps", app), { recursive: true });
    for (const command of ["docker", "openssl"]) {
      writeFileSync(path.join(bin, command), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }
    writeFileSync(
      path.join(bin, "pnpm"),
      `#!/bin/sh
printf '%s|%s|%s|%s|%s\\n' "$*" "$DATABASE_URL" "$BETTER_AUTH_URL" "$WEB_ORIGIN" "$API_INTERNAL_URL" >> "$INIT_TEST_LOG"
`,
      { mode: 0o755 },
    );
    writeFileSync(
      path.join(directory, ".env"),
      [
        "BETTER_AUTH_SECRET=local-test-bootstrap-secret",
        "APP_ENCRYPTION_KEY=local-test-bootstrap-key",
        "POSTGRES_PORT=55449",
        "POSTGRES_USER=test",
        "POSTGRES_PASSWORD=local-test-password",
        "POSTGRES_DB=bootstrap",
        "WEB_PORT=3080",
        "API_PORT=3012",
        "PUBLIC_ORIGIN=http://localhost:3080",
      ].join("\n") + "\n",
    );
    const log = path.join(directory, "commands.log");
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, INIT_TEST_LOG: log };
    for (const key of ["DATABASE_URL", "BETTER_AUTH_URL", "WEB_ORIGIN", "API_INTERNAL_URL"])
      delete env[key];
    // init.sh's kill-0 EXIT trap must target only this disposable process group.
    const result = spawnSync("bash", ["init.sh"], {
      cwd: directory,
      env,
      detached: true,
      timeout: 10_000,
    });
    assert.ok(result.status === 0 || result.signal === "SIGTERM", result.stderr?.toString());
    const commands = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => line.split("|"));
    for (const [, database, authOrigin, webOrigin, proxyOrigin] of commands) {
      assert.equal(database, "postgres://test:local-test-password@localhost:55449/bootstrap");
      assert.equal(authOrigin, "http://localhost:3080");
      assert.equal(webOrigin, "http://localhost:3080");
      assert.equal(proxyOrigin, "http://localhost:3012");
    }
    assert.ok(commands.some(([command]) => command === "exec next dev --port 3080"));
    assert.equal(commands.filter(([command]) => command === "start").length, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
