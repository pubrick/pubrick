import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("both local and release workers retain the 270s graceful receipt window", () => {
  const compose = readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8");
  const overlay = readFileSync(new URL("../docker-compose.release.yml", import.meta.url), "utf8");
  const worker = compose.split("\n  worker:\n")[1]?.split("\n  web:\n")[0];
  assert.ok(worker);
  assert.match(worker, /stop_grace_period: 270s/);
  assert.doesNotMatch(overlay, /stop_grace_period:/);
  for (const service of ["api", "worker"]) {
    const section = compose.split(`\n  ${service}:\n`)[1]?.split(/\n {2}[a-z]+:\n/)[0];
    assert.ok(section);
    for (const provider of ["THREADS", "INSTAGRAM", "FACEBOOK"]) {
      for (const field of ["CLIENT_ID", "CLIENT_SECRET"])
        assert.ok(section.includes(`${provider}_${field}:`));
    }
    assert.match(section, /META_GRAPH_API_VERSION: "\$\{META_GRAPH_API_VERSION:-v26\.0\}"/);
  }
});
