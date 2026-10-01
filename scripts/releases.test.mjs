import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateRelease } from "./validate-release.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

test("release validation rejects aliases, moved tags and unmerged source", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "pubrick-release-contract-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
  try {
    git("init", "--initial-branch=main");
    git("config", "user.name", "Release contract");
    git("config", "user.email", "release-contract@example.invalid");
    git("commit", "--allow-empty", "-m", "baseline");
    const sha = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/main", sha);
    git("tag", "v0.1.0", sha);
    assert.deepEqual(validateRelease({ tag: "v0.1.0", sha, cwd }), { tag: "v0.1.0", sha });
    for (const tag of ["latest", "main", "v01.1.0", "v1.0.0;echo bad", "--help"]) {
      assert.throws(() => validateRelease({ tag, sha, cwd }), /Release tag/);
    }
    for (const invalid of [sha.slice(0, 7), "main", "-x", sha.toUpperCase()]) {
      assert.throws(() => validateRelease({ tag: "v0.1.0", sha: invalid, cwd }), /Source SHA/);
    }
    git("commit", "--allow-empty", "-m", "not merged");
    const unmerged = git("rev-parse", "HEAD");
    assert.throws(
      () => validateRelease({ tag: "v0.1.0", sha: unmerged, cwd }),
      /Tag does not point/,
    );
    git("tag", "v0.2.0-beta.1", unmerged);
    assert.throws(() => validateRelease({ tag: "v0.2.0-beta.1", sha: unmerged, cwd }));
    git("update-ref", "refs/remotes/origin/main", unmerged);
    assert.equal(validateRelease({ tag: "v0.2.0-beta.1", sha: unmerged, cwd }).sha, unmerged);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

const composeAvailable =
  spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;
test("image deployment removes builds and preserves runtime wiring", {
  skip: !composeAvailable,
}, () => {
  const env = {
    ...process.env,
    PUBLIC_ORIGIN: "http://localhost:3999",
    BETTER_AUTH_SECRET: "release-contract-secret",
    APP_ENCRYPTION_KEY: "release-contract-key",
    PUBLIC_API_MAX_OPERATION_RECORDS: "54321",
    PUBRICK_API_IMAGE: `ghcr.io/pubrick/pubrick-api@sha256:${"a".repeat(64)}`,
    PUBRICK_WORKER_IMAGE: `ghcr.io/pubrick/pubrick-worker@sha256:${"b".repeat(64)}`,
    PUBRICK_WEB_IMAGE: `ghcr.io/pubrick/pubrick-web@sha256:${"c".repeat(64)}`,
  };
  const args = [
    "compose",
    "--env-file",
    "/dev/null",
    "-f",
    "docker-compose.yml",
    "-f",
    "docker-compose.release.yml",
    "config",
    "--format",
    "json",
  ];
  const configuration = JSON.parse(
    execFileSync("docker", args, { cwd: root, env, encoding: "utf8", stdio: "pipe" }),
  );
  assert.equal(configuration.services.api.environment.PUBLIC_API_MAX_OPERATION_RECORDS, "54321");
  const defaults = JSON.parse(
    execFileSync("docker", args, {
      cwd: root,
      env: { ...env, PUBLIC_API_MAX_OPERATION_RECORDS: "" },
      encoding: "utf8",
      stdio: "pipe",
    }),
  );
  assert.equal(defaults.services.api.environment.PUBLIC_API_MAX_OPERATION_RECORDS, "100000");
  for (const service of ["api", "worker", "web"]) {
    assert.equal(
      configuration.services[service].build,
      undefined,
      `${service} must never build local source`,
    );
    assert.equal(
      configuration.services[service].image,
      env[`PUBRICK_${service.toUpperCase()}_IMAGE`],
    );
    assert.equal(configuration.services[service].pull_policy, "always");
  }
  const ci = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  assert.match(
    configuration.services.postgres.image,
    /^pgvector\/pgvector:pg16@sha256:[a-f0-9]{64}$/,
  );
  assert.ok(
    ci.includes(configuration.services.postgres.image),
    "release and database CI use the same database image",
  );
  assert.equal(
    configuration.services.worker.environment.APP_ENCRYPTION_KEY,
    configuration.services.api.environment.APP_ENCRYPTION_KEY,
  );
  assert.ok(configuration.services.api.healthcheck);
  assert.equal(configuration.services.worker.depends_on.api.condition, "service_healthy");
  assert.equal(configuration.services.web.depends_on.api.condition, "service_healthy");
  for (const service of ["API", "WORKER", "WEB"]) {
    const missing = { ...env, [`PUBRICK_${service}_IMAGE`]: "" };
    assert.notEqual(
      spawnSync("docker", args, { cwd: root, env: missing, stdio: "pipe" }).status,
      0,
    );
  }
});

test("release workflow publishes only manually selected immutable source", () => {
  const workflow = readFileSync(path.join(root, ".github/workflows/release.yml"), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^ {2}(push|pull_request|schedule):/m);
  assert.match(workflow, /if: github.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /node scripts\/validate-release.mjs/);
  assert.match(workflow, /ref: \$\{\{ needs.validate.outputs.sha \}\}/);
  assert.match(workflow, /platforms: linux\/amd64,linux\/arm64/);
  assert.match(workflow, /gh release create .*--verify-tag --draft/);
  assert.doesNotMatch(workflow, /:latest|--clobber|contents: write\n {6}packages: write/);
  for (const line of workflow.split("\n").filter((line) => line.includes("uses:"))) {
    assert.match(
      line,
      /uses: [\w/-]+@[a-f0-9]{40} /,
      "release actions must be pinned to reviewed source",
    );
  }
});
