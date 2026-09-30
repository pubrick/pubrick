import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseArguments, recover, validateSnapshot } from "./recovery.mjs";

function fixture(options = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "pubrick-recovery-unit-"));
  const cwd = path.join(root, "checkout");
  mkdirSync(cwd);
  writeFileSync(path.join(cwd, ".env"), "APP_ENCRYPTION_KEY=secret\n", { mode: 0o644 });
  const calls = [];
  const config = {
    services: {
      postgres: {
        image: "pgvector/pgvector:pg16",
        environment: { POSTGRES_USER: "test", POSTGRES_DB: "test" },
      },
      api: {
        environment: { APP_ENCRYPTION_KEY: "secret", BETTER_AUTH_SECRET: "auth" },
        volumes: [{ type: "volume", source: "media", target: "/data/media" }],
      },
    },
    volumes: { media: { name: "isolated_media" } },
  };
  const execute = (_command, args, commandOptions) => {
    calls.push(args);
    let stdout = "";
    if (args.includes("config")) stdout = JSON.stringify(config);
    if (args.includes("ps") && args.includes("--quiet"))
      stdout = options.runtimeMismatch ? "source-api-id" : "";
    else if (args.includes("ps"))
      stdout = (options.running ?? ["postgres", "api", "worker"]).join("\n");
    if (args[0] === "inspect")
      stdout = JSON.stringify([
        {
          Config: { Env: ["APP_ENCRYPTION_KEY=old-secret", "BETTER_AUTH_SECRET=auth"] },
          Mounts: [{ Destination: "/data/media", Name: "isolated_media" }],
        },
      ]);
    if (args.includes("pg_dump") && options.failDump)
      return { status: 1, stderr: "secret diagnostic" };
    if (args.includes("find") && options.mediaNonempty) stdout = "/media/existing.jpg\n";
    if (args.includes("--single-transaction") && options.failRestore)
      return { status: 1, stderr: "private data diagnostic" };
    if (args.includes("psql")) stdout = options.nonempty ? "1\n" : "0\n";
    if (args.includes("-tf")) stdout = options.unsafe ? "../secret\n" : "./\n./image.jpg\n";
    if (args.includes("-tvf")) stdout = "drwx ./\n-rw image.jpg\n";
    if (typeof commandOptions.stdio[1] === "number")
      writeFileSync(commandOptions.stdio[1], "snapshot payload");
    return { status: 0, stdout };
  };
  return {
    cwd,
    calls,
    config,
    execute,
    directory: path.join(root, "snapshot"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
test("backup quiesces writers, protects secrets, commits a checksummed snapshot and resumes only previously running services", () => {
  const state = fixture();
  try {
    recover({ action: "backup", project: "isolated", ...state });
    validateSnapshot(state.directory);
    assert.equal(statSync(state.directory).mode & 0o777, 0o700);
    for (const file of [
      "environment.env",
      "compose.json",
      "database.dump",
      "media.tar",
      "manifest.json",
    ])
      assert.equal(statSync(path.join(state.directory, file)).mode & 0o777, 0o600);
    const index = (operation) => state.calls.findIndex((args) => args.includes(operation));
    assert.ok(index("stop") < index("pg_dump"));
    assert.ok(index("pg_dump") < index("start"));
    assert.deepEqual(state.calls.find((args) => args.includes("start")).slice(-3), [
      "start",
      "api",
      "worker",
    ]);
    assert.match(readFileSync(path.join(state.directory, "compose.json"), "utf8"), /secret/);
  } finally {
    state.cleanup();
  }
});
test("failed backup removes partial output and resumes writers without leaking Docker diagnostics", () => {
  const state = fixture({ failDump: true });
  try {
    assert.throws(
      () => recover({ action: "backup", project: "isolated", ...state }),
      /Docker operation failed/,
    );
    assert.ok(state.calls.some((args) => args.includes("start")));
    assert.throws(() => statSync(state.directory), /ENOENT/);
    assert.throws(() => statSync(path.join(state.cwd, ".recovery-isolated.lock")), /ENOENT/);
  } finally {
    state.cleanup();
  }
});
for (const scenario of ["checksum", "nonempty", "media", "unsafe", "running", "key", "partial"]) {
  test(`restore refuses ${scenario} before importing data and never starts the worker`, () => {
    const state = fixture();
    try {
      recover({ action: "backup", project: "isolated", ...state });
      if (scenario === "checksum")
        writeFileSync(path.join(state.directory, "database.dump"), "corrupted");
      if (scenario === "partial") {
        const manifestFile = path.join(state.directory, "manifest.json");
        const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
        manifest.complete = false;
        writeFileSync(manifestFile, JSON.stringify(manifest));
      }
      const target = fixture({
        running: scenario === "running" ? ["postgres", "worker"] : ["postgres"],
        nonempty: scenario === "nonempty",
        mediaNonempty: scenario === "media",
        unsafe: scenario === "unsafe",
      });
      if (scenario === "key")
        target.config.services.api.environment.APP_ENCRYPTION_KEY = "different";
      try {
        assert.throws(() =>
          recover({
            action: "restore",
            project: "isolated",
            ...target,
            directory: state.directory,
          }),
        );
        assert.ok(!target.calls.some((args) => args.includes("--single-transaction")));
        assert.ok(!target.calls.some((args) => args.includes("start")));
      } finally {
        target.cleanup();
      }
    } finally {
      state.cleanup();
    }
  });
}
test("successful restore uses a transaction and keeps all application services paused", () => {
  const state = fixture();
  const target = fixture({ running: ["postgres"] });
  try {
    recover({ action: "backup", project: "isolated", ...state });
    recover({ action: "restore", project: "isolated", ...target, directory: state.directory });
    assert.ok(
      target.calls.some(
        (args) => args.includes("--single-transaction") && args.includes("--exit-on-error"),
      ),
    );
    assert.ok(!target.calls.some((args) => args.includes("start") || args.includes("up")));
  } finally {
    state.cleanup();
    target.cleanup();
  }
});

test("release Compose overlays retain order and strict argument parsing rejects typos", () => {
  const options = parseArguments([
    "backup",
    "--project",
    "isolated",
    "--compose-file",
    "docker-compose.yml",
    "--compose-file",
    "docker-compose.release.yml",
    "--directory",
    "/backup",
  ]);
  assert.deepEqual(options.composeFiles, ["docker-compose.yml", "docker-compose.release.yml"]);
  assert.throws(() => parseArguments(["backup", "--unknown", "value"]));
  assert.throws(() => parseArguments(["backup", "--project"]));
  const state = fixture();
  try {
    recover({
      action: "backup",
      project: "isolated",
      ...state,
      composeFiles: options.composeFiles,
    });
    for (const args of state.calls.filter((args) => args[0] === "compose")) {
      const first = args.indexOf("--file");
      assert.deepEqual(args.slice(first, first + 4), [
        "--file",
        "docker-compose.yml",
        "--file",
        "docker-compose.release.yml",
      ]);
    }
    assert.ok(
      state.calls
        .filter((args) => args[0] === "run")
        .every((args) => args.includes("--pull=never")),
    );
  } finally {
    state.cleanup();
  }
});
test("backup refuses plaintext snapshots within the checkout", () => {
  const state = fixture();
  try {
    assert.throws(
      () =>
        recover({
          action: "backup",
          project: "isolated",
          ...state,
          directory: path.join(state.cwd, "backup"),
        }),
      /outside the checkout/,
    );
  } finally {
    state.cleanup();
  }
});

test("failed database restore keeps application services paused and suppresses private diagnostics", () => {
  const state = fixture();
  const target = fixture({ running: ["postgres"], failRestore: true });
  try {
    recover({ action: "backup", project: "isolated", ...state });
    assert.throws(
      () =>
        recover({ action: "restore", project: "isolated", ...target, directory: state.directory }),
      (error) => {
        assert.match(error.message, /Docker operation failed/);
        assert.ok(!error.message.includes("private data"));
        return true;
      },
    );
    assert.ok(!target.calls.some((args) => args.includes("start") || args.includes("up")));
  } finally {
    state.cleanup();
    target.cleanup();
  }
});

test("backup refuses changed runtime encryption keys before stopping writers", () => {
  const state = fixture({ runtimeMismatch: true });
  try {
    assert.throws(
      () => recover({ action: "backup", project: "isolated", ...state }),
      /configuration differs/,
    );
    assert.ok(!state.calls.some((args) => args.includes("stop") || args.includes("pg_dump")));
  } finally {
    state.cleanup();
  }
});
