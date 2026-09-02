#!/usr/bin/env node
/**
 * Runs one workspace's test suite REPEATEDLY against the working tree as it
 * stands, and reports a mutation verdict only when every run agreed.
 *
 * Why this exists: for six increments the way a guard was proved to be pinned
 * was "break it, run the suite, see it go red". That reasoning is only as sound
 * as the suite's determinism, and a single run cannot tell a real SURVIVED from
 * a test that happened not to fail this time. This script does not make the
 * suite deterministic — it makes a NON-deterministic answer visible instead of
 * letting it be recorded as a fact.
 *
 *   # 1. Confirm the clean tree is green, N times. Any red here is flake, not a
 *   #    mutation, and nothing measured after it means anything.
 *   node scripts/mutation-check.mjs @pubrick/api --runs 3
 *
 *   # 2. Apply ONE mutation by hand, then re-run the same command.
 *   node scripts/mutation-check.mjs @pubrick/api --runs 3
 *
 *   # 3. Revert the mutation.
 *
 * Needs the same env the suite does — TEST_DATABASE_URL, BETTER_AUTH_SECRET,
 * APP_ENCRYPTION_KEY — and a database nothing else is writing to.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const filter = argv.find((a) => !a.startsWith("--"));
const runs = Number(argv[argv.indexOf("--runs") + 1] ?? 3);
const files = argv.slice(argv.indexOf("--files") + 1).filter((a) => !a.startsWith("--"));
const only = argv.includes("--files") ? files : [];

if (!filter || !Number.isInteger(runs) || runs < 2) {
  console.error(
    "usage: node scripts/mutation-check.mjs <pnpm-filter> [--runs N>=2] [--files a.spec.ts ...]\n" +
      "  one run cannot answer a verdict question, so --runs must be at least 2",
  );
  process.exit(2);
}
if (!process.env.TEST_DATABASE_URL) {
  console.error(
    "TEST_DATABASE_URL is unset: the database-backed specs would SKIP themselves and\n" +
      "every mutation would read SURVIVED. Refusing to report a verdict.",
  );
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), "pubrick-mutation-"));
/** @type {{verdict: string, failed: string[]}[]} */
const results = [];

try {
  for (let i = 0; i < runs; i++) {
    const out = join(dir, `run-${i}.json`);
    let exit = 0;
    try {
      execFileSync(
        "pnpm",
        [
          "--filter",
          filter,
          "exec",
          "vitest",
          "run",
          "--reporter=json",
          `--outputFile=${out}`,
          ...only,
        ],
        { stdio: ["ignore", "ignore", "ignore"] },
      );
    } catch (error) {
      exit = error.status ?? 1;
    }

    let passed = 0;
    const failed = [];
    try {
      const report = JSON.parse(readFileSync(out, "utf8"));
      for (const suite of report.testResults ?? []) {
        for (const assertion of suite.assertionResults ?? []) {
          if (assertion.status === "passed") passed++;
          else failed.push(`${suite.name.split("/src/")[1] ?? suite.name} > ${assertion.fullName}`);
        }
      }
    } catch {
      // A run that produced no report at all (crash, OOM, killed) is not a
      // verdict either — record it as its own outcome so it cannot be averaged
      // away into a KILLED.
      failed.push("<the run produced no report>");
    }

    const verdict = exit === 0 ? "SURVIVED" : "KILLED";
    results.push({ verdict, failed });
    console.log(
      `run ${i + 1}/${runs}: ${verdict}  (${passed} passed, ${failed.length} failed)` +
        failed
          .slice(0, 3)
          .map((f) => `\n    - ${f}`)
          .join(""),
    );
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const verdicts = new Set(results.map((r) => r.verdict));
console.log("");
if (verdicts.size > 1) {
  console.log(
    `INCONCLUSIVE — the runs disagree: ${results.map((r) => r.verdict).join(", ")}.\n` +
      "This suite answered a verdict question two different ways on the same code, so\n" +
      "NEITHER answer may be recorded. Fix the flake first; a mutation log written over\n" +
      "a suite in this state carries both false kills and false survivors.",
  );
  process.exit(1);
}

const verdict = [...verdicts][0];
// A stable verdict reached by a different test each time is still not one fact.
const killers = new Set(results.map((r) => [...r.failed].sort().join("\n")));
if (verdict === "KILLED" && killers.size > 1) {
  console.log(
    `INCONCLUSIVE — KILLED on all ${runs} runs, but by a DIFFERENT set of tests each time.\n` +
      "Something other than the mutation is moving. Do not record which test pins this line.",
  );
  process.exit(1);
}

console.log(`VERDICT: ${verdict} — unanimous across ${runs}/${runs} runs.`);
if (verdict === "KILLED")
  console.log(`Killed by:\n${results[0].failed.map((f) => `  - ${f}`).join("\n")}`);
