import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { validateReleaseAssets } from "./validate-release-assets.mjs";

const tag = "v0.1.0-beta.1";
const sha = "a".repeat(40);
const services = ["api", "worker", "web"];
const records = () =>
  services.map((service, index) => ({
    service,
    image: `ghcr.io/pubrick/pubrick-${service}@sha256:${String(index + 1).repeat(64)}`,
    tag,
    sourceSha: sha,
    platforms: ["linux/amd64", "linux/arm64"],
  }));
const assignments = (manifest) =>
  manifest.map((entry) => `PUBRICK_${entry.service.toUpperCase()}_IMAGE=${entry.image}`).join("\n");
const check = (manifest, env = assignments(manifest), expected = {}) =>
  validateReleaseAssets({
    manifest,
    env,
    tag,
    sha,
    repository: "pubrick/pubrick",
    ...expected,
  });

test("accepts the exact three digest assets regardless of record order", () => {
  const manifest = records().reverse();
  assert.deepEqual(check(manifest), { tag, sha, services });
  assert.deepEqual(check(manifest, `${assignments(manifest)}\n`), { tag, sha, services });
});

for (const [name, alter] of [
  [
    "mixed version",
    (r) => {
      r[1].tag = "v0.2.0";
    },
  ],
  [
    "mixed source",
    (r) => {
      r[1].sourceSha = "b".repeat(40);
    },
  ],
  [
    "wrong repository",
    (r) => {
      r[1].image = r[1].image.replace("pubrick/pubrick-", "other/pubrick-");
    },
  ],
  [
    "wrong service image",
    (r) => {
      r[1].image = r[0].image;
    },
  ],
  [
    "mutable image",
    (r) => {
      r[1].image = "ghcr.io/pubrick/pubrick-worker:latest";
    },
  ],
  [
    "missing platform",
    (r) => {
      r[1].platforms.pop();
    },
  ],
  [
    "duplicate platform",
    (r) => {
      r[1].platforms[1] = "linux/amd64";
    },
  ],
  [
    "nested platform arrays",
    (r) => {
      r[1].platforms = [["linux/amd64"], ["linux/arm64"]];
    },
  ],
  [
    "extra platform",
    (r) => {
      r[1].platforms.push("linux/386");
    },
  ],
  [
    "duplicate service",
    (r) => {
      r[1] = { ...r[0] };
    },
  ],
  [
    "missing service",
    (r) => {
      r.pop();
    },
  ],
  [
    "extra service",
    (r) => {
      r.push({ ...r[0], service: "postgres" });
    },
  ],
  [
    "unknown metadata",
    (r) => {
      r[1].extra = "unexpected";
    },
  ],
]) {
  test(`refuses ${name}`, () => {
    const manifest = records();
    alter(manifest);
    assert.throws(() => check(manifest), /Invalid release assets/);
  });
}

test("refuses altered, duplicate, missing and executable assignments", () => {
  const manifest = records();
  const env = assignments(manifest);
  for (const invalid of [
    env.replace("1".repeat(64), "9".repeat(64)),
    `${env}\n${env.split("\n")[0]}`,
    env.split("\n").slice(1).join("\n"),
    `${env}\nPUBLIC_ORIGIN=https://example.invalid`,
    `${env}\necho injected`,
    env.replace("ghcr.io", "$(echo ghcr.io)"),
  ])
    assert.throws(() => check(manifest, invalid), /Invalid release assets/);
});

test("expected identities are explicit and validated before accepting assets", () => {
  for (const expected of [
    { tag: "latest" },
    { tag: "v01.0.0" },
    { tag: "v0.2.0" },
    { sha: "main" },
    { sha: "b".repeat(40) },
    { repository: "other/pubrick" },
    { repository: "../pubrick" },
  ])
    assert.throws(() => check(records(), undefined, expected), /Invalid release assets/);
  for (const manifest of [null, {}, "not an array", [null, null, null]]) {
    assert.throws(() => check(manifest, ""), /Invalid release assets/);
  }
});

test("operator CLI reads downloaded artifacts and fails without exposing input", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "pubrick-release-assets-"));
  const script = new URL("./validate-release-assets.mjs", import.meta.url);
  const run = (...args) =>
    spawnSync(process.execPath, [script.pathname, ...args], {
      cwd,
      encoding: "utf8",
      env: process.env,
    });
  try {
    const manifest = records();
    writeFileSync(path.join(cwd, "release-manifest.json"), JSON.stringify(manifest));
    writeFileSync(path.join(cwd, "release-images.env"), assignments(manifest));
    const accepted = run("--tag", tag, "--source-sha", sha);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(accepted.stdout, /Release assets match/);
    for (const args of [[], ["--tag", tag, "--source-sha", sha, "--unknown"]]) {
      assert.equal(run(...args).status, 1);
    }
    const sentinel = "PRIVATE_INPUT_MUST_NOT_BE_PRINTED";
    writeFileSync(path.join(cwd, "release-images.env"), sentinel);
    const invalid = run("--tag", tag, "--source-sha", sha);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /do not install/);
    assert.ok(!`${invalid.stdout}${invalid.stderr}`.includes(sentinel));
    writeFileSync(path.join(cwd, "release-manifest.json"), "not valid JSON");
    assert.equal(run("--tag", tag, "--source-sha", sha).status, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
