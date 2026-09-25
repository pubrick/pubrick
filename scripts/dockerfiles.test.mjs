import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const packages = new Map();

for (const area of ["apps", "packages"]) {
  for (const entry of readdirSync(path.join(root, area), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = `${area}/${entry.name}/package.json`;
    const manifest = JSON.parse(readFileSync(path.join(root, manifestPath), "utf8"));
    packages.set(manifest.name, { manifestPath, manifest });
  }
}

function workspaceClosure(name, found = new Set()) {
  if (found.has(name)) return found;
  const item = packages.get(name);
  assert.ok(item, `Missing workspace package ${name}`);
  found.add(name);
  for (const [dependency, version] of Object.entries({
    ...item.manifest.dependencies,
    ...item.manifest.devDependencies,
  })) {
    if (version.startsWith("workspace:")) workspaceClosure(dependency, found);
  }
  return found;
}

for (const service of ["api", "worker", "web"]) {
  test(`${service} image installs its build dependency closure`, () => {
    const dockerfile = readFileSync(path.join(root, `docker/${service}.Dockerfile`), "utf8");
    const target = `@pubrick/${service}`;
    const depsStage = dockerfile.split("FROM deps AS build")[0];
    assert.match(dockerfile, new RegExp(`RUN pnpm --filter ${target}\\.\\.\\. build`));
    for (const name of workspaceClosure(target)) {
      const manifestPath = packages.get(name).manifestPath;
      assert.ok(
        depsStage.includes(`COPY ${manifestPath} ${manifestPath}`),
        `${service} image must install ${manifestPath} before building`,
      );
    }
  });
}
