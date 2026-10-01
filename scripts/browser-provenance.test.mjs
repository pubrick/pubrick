import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  BROWSER_POSTGRES_IMAGE,
  readBrowserSource,
  verifyBrowserSource,
} from "./e2e/browser-provenance.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const runners = ["run.mjs", "hosted.run.mjs", "recurring.run.mjs", "evergreen.run.mjs"];

test("source receipt requires a clean real commit and rejects changes during acceptance", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pubrick-browser-source-"));
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const commit = () => {
    git("add", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "fixture",
    );
  };
  try {
    assert.throws(() => readBrowserSource(cwd), /Cannot verify browser source commit/);
    git("init", "-q");
    assert.throws(() => readBrowserSource(cwd), /Cannot verify browser source commit/);
    writeFileSync(join(cwd, "source.txt"), "first\n");
    commit();
    const source = git("rev-parse", "HEAD");
    assert.equal(readBrowserSource(cwd), source);
    verifyBrowserSource(source, cwd);
    writeFileSync(join(cwd, "source.txt"), "changed\n");
    assert.throws(() => verifyBrowserSource(source, cwd), /Commit browser source changes/);
    commit();
    assert.throws(() => verifyBrowserSource(source, cwd), /commit changed during acceptance/);
    const next = readBrowserSource(cwd);
    writeFileSync(join(cwd, "untracked.txt"), "new source\n");
    assert.throws(() => verifyBrowserSource(next, cwd), /Commit browser source changes/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("all browser runners refuse unavailable Git before builds or owned resource allocation", () => {
  const directory = mkdtempSync(join(tmpdir(), "pubrick-browser-no-git-"));
  try {
    const touched = join(directory, "unexpected-command");
    writeFileSync(join(directory, "git"), "#!/bin/sh\nexit 69\n", { mode: 0o755 });
    for (const name of ["docker", "pnpm"])
      writeFileSync(join(directory, name), '#!/bin/sh\n: > "$TOUCHED"\nexit 1\n', { mode: 0o755 });
    for (const runner of runners) {
      const result = spawnSync(process.execPath, [join(root, "scripts/e2e", runner)], {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, PATH: directory, TMPDIR: directory, TOUCHED: touched },
      });
      assert.equal(result.status, 1, runner);
      assert.match(result.stderr, /Cannot verify browser source commit/, runner);
      assert.doesNotMatch(result.stdout, /acceptance passed|Disposable browser stack/, runner);
      assert.equal(existsSync(touched), false, runner);
      // Resource names are printed only after their allocation; additionally
      // verify no runner-owned temporary directory exists after failed preflight.
      assert.equal(
        readdirSync(directory).some((name) => name.startsWith("pubrick-")),
        false,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("all browser runners use the reviewed CI database digest and verify final source", () => {
  const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  assert.ok(workflow.includes(`image: ${BROWSER_POSTGRES_IMAGE}`));
  for (const runner of runners) {
    const source = readFileSync(join(root, "scripts/e2e", runner), "utf8");
    assert.ok(source.includes("BROWSER_POSTGRES_IMAGE,"), runner);
    assert.ok(source.includes("verifyBrowserSource(source);"), runner);
    assert.ok(
      source.indexOf("const source = readBrowserSource();") < source.indexOf("await mkdtemp("),
    );
    assert.match(source, /database \$\{BROWSER_POSTGRES_IMAGE\}/, runner);
    assert.doesNotMatch(source, /"pgvector\/pgvector:pg16"/);
  }
});
