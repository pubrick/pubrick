import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("Docker COPY excludes runtime secrets and local data while retaining configuration examples", {
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: this isolated Docker probe is outside Turbo tasks.
  skip: process.env.PUBRICK_DOCKER_CONTEXT_TEST !== "1",
  timeout: 60_000,
}, async () => {
  // Build only a synthetic context. Never copy the operator's checkout or secrets.
  const fixture = await mkdtemp(join(tmpdir(), "pubrick-docker-context-"));
  const input = join(fixture, "input");
  const output = join(fixture, "output");
  try {
    await mkdir(input);
    await writeFile(
      join(input, ".dockerignore"),
      await readFile(new URL("../.dockerignore", import.meta.url)),
    );
    await writeFile(join(input, "Dockerfile"), "FROM scratch\nCOPY . /context/\n");
    const excluded = [
      ".env",
      ".env.production",
      "nested/.env.local",
      ".data/media/fixture.txt",
      ".data/browser-tests/fixture.txt",
      "nested/.data/fixture.txt",
    ];
    const retained = ["app.js", ".env.example", "nested/.env.example"];
    for (const path of [...excluded, ...retained]) {
      const target = join(input, path);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, "synthetic fixture\n");
    }
    const built = spawnSync("docker", ["build", "--output", `type=local,dest=${output}`, input], {
      encoding: "utf8",
      timeout: 55_000,
    });
    assert.equal(built.status, 0, built.error?.message ?? built.stderr);
    for (const path of excluded)
      assert.equal(existsSync(join(output, "context", path)), false, `Excluded: ${path}`);
    for (const path of retained)
      assert.equal(existsSync(join(output, "context", path)), true, `Retained: ${path}`);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
