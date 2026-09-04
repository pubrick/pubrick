import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The general form of the bug that let 209 database tests skip themselves
 * behind a green badge on 2026-08-24 (docs/lessons.md): turbo's strict env
 * mode passes a task ONLY the variables it declares in turbo.json, so any
 * `process.env.X` this workspace reads without declaring X reaches the
 * running code as `undefined` — not an error, not a warning, just the
 * variable's fallback (or its absence) standing in for whatever an operator,
 * a CI secret, or a local `.env` actually set. db-tier.guard.spec.ts closed
 * the ONE instance of this — a single hard-coded gate variable
 * (`TEST_DATABASE_URL`) used to skip a suite. This file closes the CLASS:
 * every static `process.env.X` read anywhere in this workspace, whatever it
 * is used for, must name a variable turbo.json declares for the task that
 * actually executes the code doing the reading.
 *
 * THE PROPERTY THIS FILE CLAIMS
 *
 *   Every `process.env.X` read (X a fixed name, not a computed expression),
 *   found by parsing the real syntax tree of every source file in this
 *   workspace's backend packages — outside the env module itself — names a
 *   variable declared in turbo.json's `test` task. A read this scan cannot
 *   place, in a file it cannot parse, is a failure here rather than an
 *   omission, for the same reason as db-tier.guard.spec.ts: a scanner that
 *   silently drops what it cannot classify reads identically to "nothing to
 *   report" (see docs/lessons.md and the discovery-pattern failure that
 *   rewrote that file on 2026-09-02 — the exact failure mode this one is
 *   built not to repeat).
 *
 * WHERE THE ENV-MODULE BOUNDARY SITS
 *
 * `apps/api/src/env.ts`, `apps/worker/src/env.ts` and
 * `packages/shared/src/env.ts` are excluded by filename, not by variable
 * name — "the env module", exactly as the issue that asked for this file put
 * it. They are excluded because they already fail LOUD on a missing
 * variable: `parseEnv` (packages/shared/src/env.ts) runs every declared key
 * through a zod shape with no implicit optionality, so a stripped required
 * variable throws `Invalid environment: ...` at boot instead of quietly
 * defaulting. That is the opposite failure shape from the one this guard
 * exists to catch — outside those three files, nothing enforces that a read
 * variable was ever declared anywhere at all.
 *
 * WHAT COUNTS AS A "READ"
 *
 * `process.env.X` and `process.env["X"]` (a fixed name either way) count,
 * anywhere they appear as a value — a condition, a default via `??`, the
 * right side of `=`, inside `??=`/`+=`/any compound assignment (which reads
 * before it writes). Two shapes do NOT count, and are excluded structurally
 * rather than by name:
 *
 *   - `process.env.X = value` (plain `=`, X on the left) — a pure write.
 *     Nothing reads the incoming value, so a stripped X changes nothing;
 *     `apps/api/src/auth.e2e.spec.ts`'s `process.env.SIGNUP_MODE = "open"`
 *     lines are this shape throughout its per-test setup.
 *   - `delete process.env.X` — cleanup, not a consumed value.
 *   - `process.env[name]` where `name` is a variable, not a string literal —
 *     there is no fixed name here to declare. `env.spec.ts`'s snapshot/restore
 *     helper (`for (const name of Object.keys(process.env)) ...
 *     process.env[name]`) is exactly this: generic environment-manipulation
 *     tooling for testing the env module, not a read of one named variable.
 *
 * Everything else outside the three env-module files — READ ONLY reads
 * included, like `PATH`/`HOME` in `auth.compiled.e2e.spec.ts`'s child-process
 * environment, or `SIGNUP_MODE` saved-and-restored around a test — is held to
 * the same rule with no further exemption. Some of these are "legitimate and
 * awkward": PATH and HOME are OS plumbing nobody would think to add to a
 * turbo task's env list, and SIGNUP_MODE is forced to a fixed value by
 * `vitest.config.ts`'s own `test.env` regardless of what turbo passes
 * through. Declaring them in turbo.json's `test.env` anyway is not wrong —
 * it is what this codebase already does for `CI` (see db-tier.guard.spec.ts:
 * turbo happens to pass it through today, and it is declared explicitly
 * anyway, because an undeclared variable sits outside the task hash even
 * when today's behaviour is harmless). A brute-force "every read is
 * declared, no exceptions list" rule is simpler to keep correct than a rule
 * that has to be right about which reads are safe to skip — and a hand-kept
 * "this one's fine" list is exactly the shape issue #9's exemption list
 * would have been, which this project is moving away from, not toward.
 *
 * WHY THIS SCAN'S SURFACE STOPS AT THE BACKEND PACKAGES
 *
 * Every package this file scans (api, worker, packages/db, packages/ai,
 * packages/shared) builds with `tsup` or `nest build` — pure compilation, no
 * application code runs. The ONLY turbo task that ever executes their source
 * is `test` (vitest actually imports and runs the module graph, spec files
 * and the application files they pull in alike) — see the assumption check
 * below, which fails loudly if a package's build script stops matching that
 * shape. `apps/web` is different: `next build` evaluates modules directly
 * (next.config.ts, prerendered pages), so a read there can be a `build`-task
 * concern instead — but apps/web, packages/integrations and docker/** belong
 * to other work in flight against this repository and are out of this
 * file's editable surface; this guard's surface matches what it can act on.
 */

/** Vitest's cwd is apps/api under both `pnpm --filter …` and turbo. */
const REPO_ROOT = repoRoot();
const SELF = "env-declaration.guard.spec.ts";
const ENV_MODULE_BASENAME = "env.ts";
const SKIP_DIRS = new Set(["node_modules", "dist", ".turbo", "coverage"]);

/** Backend packages this guard scans, and the build command each one is
 *  assumed to run — a pure compiler, never application code. */
const PACKAGES: readonly { dir: string; expectedBuild: RegExp }[] = [
  { dir: "apps/api", expectedBuild: /^nest build$/ },
  { dir: "apps/worker", expectedBuild: /^tsup\b/ },
  { dir: "packages/db", expectedBuild: /^tsup\b/ },
  { dir: "packages/ai", expectedBuild: /^tsup\b/ },
  { dir: "packages/shared", expectedBuild: /^tsup\b/ },
];

function repoRoot(): string {
  let dir = process.cwd();
  while (!existsSync(path.join(dir, "turbo.json"))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`No turbo.json above ${process.cwd()}`);
    dir = parent;
  }
  return dir;
}

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      found.push(...sourceFiles(path.join(dir, entry.name)));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    if (entry.name === ENV_MODULE_BASENAME) continue;
    if (entry.name === SELF) continue;
    found.push(path.join(dir, entry.name));
  }
  return found;
}

type EnvRead = { file: string; line: number; text: string; variable: string };
type Problem = { file: string; line: number; text: string; reason: string };

function isProcessEnv(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "process" &&
    node.name.text === "env"
  );
}

/** `process.env.X` or `process.env["X"]` → "X". A computed key
 *  (`process.env[name]`, `name` not a string literal) → null: there is no
 *  fixed name here for turbo.json to declare. */
function envTarget(node: ts.Node): { name: string; site: ts.Node } | null {
  if (ts.isPropertyAccessExpression(node)) {
    if (!isProcessEnv(node.expression)) return null;
    return { name: node.name.text, site: node };
  }
  if (ts.isElementAccessExpression(node)) {
    if (!isProcessEnv(node.expression)) return null;
    const arg = node.argumentExpression;
    if (arg && ts.isStringLiteralLike(arg)) return { name: arg.text, site: node };
    return null;
  }
  return null;
}

/** `process.env.X = value` (plain `=`, X on the left) and `delete
 *  process.env.X` do not consume the CURRENT value of X, so a stripped X
 *  changes nothing about them — excluded structurally, not by variable name. */
function isPureWrite(site: ts.Node): boolean {
  const parent = site.parent;
  if (
    parent &&
    ts.isBinaryExpression(parent) &&
    parent.left === site &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    return true;
  }
  if (parent && ts.isDeleteExpression(parent) && parent.expression === site) return true;
  return false;
}

function excerpt(node: ts.Node, source: ts.SourceFile): string {
  const text = node.getText(source).replace(/\s+/gu, " ");
  return text.length > 96 ? `${text.slice(0, 93)}…` : text;
}

function inspect(file: string, rel: string, reads: EnvRead[], problems: Problem[]): void {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const at = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  const parseErrors =
    (source as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  const firstError = parseErrors[0];
  if (firstError) {
    problems.push({
      file: rel,
      line: source.getLineAndCharacterOfPosition(firstError.start ?? 0).line + 1,
      text: ts.flattenDiagnosticMessageText(firstError.messageText, " "),
      reason: "does not parse, so nothing about it can be checked",
    });
    return;
  }

  const visit = (node: ts.Node): void => {
    const target = envTarget(node);
    if (target && !isPureWrite(target.site)) {
      reads.push({ file: rel, line: at(node), text: excerpt(node, source), variable: target.name });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
}

// A plain loop at module scope is exactly what db-tier.guard.spec.ts's own
// "refuses every construct that could stop a suite" check refuses — control
// flow at module scope could, in general, decide whether a suite registers at
// all. This file has no suite that depends on it, but that guard scans every
// spec file in the package without knowing that, so the collection happens
// inside a function and reaches module scope only as a plain variable
// initializer, which its scan does not (and should not) need to look inside.
function collectReads(): { reads: EnvRead[]; problems: Problem[] } {
  const reads: EnvRead[] = [];
  const problems: Problem[] = [];
  for (const pkg of PACKAGES) {
    const dir = path.join(REPO_ROOT, pkg.dir);
    for (const file of sourceFiles(dir)) {
      inspect(file, path.relative(REPO_ROOT, file), reads, problems);
    }
  }
  return { reads, problems };
}

const { reads, problems } = collectReads();

const readVariables = [...new Set(reads.map((r) => r.variable))].sort();

/**
 * turbo.json is JSONC — it carries explanatory `//` comments, and its own
 * `$schema` value contains a `//`. Stripping comments with a bare regex would
 * corrupt that URL, so this walks the text once, tracking string state, and
 * removes only real comments. (Same routine as db-tier.guard.spec.ts's; kept
 * here rather than imported so this file has no dependency on that one's
 * internals — the two guard different properties and should be free to
 * change independently.)
 */
function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (char === "\n") {
        inLine = false;
        out += char;
      }
      continue;
    }
    if (inBlock) {
      if (char === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        i++;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += char;
  }
  return out;
}

function turboTestEnv(): string[] {
  const config = JSON.parse(
    stripJsonComments(readFileSync(path.join(REPO_ROOT, "turbo.json"), "utf8")),
  ) as { tasks?: { test?: { env?: string[] } } };
  return config.tasks?.test?.env ?? [];
}

describe("every process.env read outside the env module is declared", () => {
  it("finds source files to scan — a scan that matches nothing is a green light for anything", () => {
    let total = 0;
    for (const pkg of PACKAGES) total += sourceFiles(path.join(REPO_ROOT, pkg.dir)).length;
    expect(total).toBeGreaterThan(20);
  });

  it("parses every scanned file", () => {
    expect(
      problems.map((p) => `${p.file}:${p.line}: ${p.reason} — ${p.text}`),
      "A file this scan cannot parse yields no reads, which reads identically to a file " +
        "with nothing to guard — so it is a failure here instead:",
    ).toEqual([]);
  });

  it("finds process.env reads to guard — a scan that matches nothing proves nothing below it", () => {
    expect(
      reads.length,
      `no process.env read found under ${PACKAGES.map((p) => p.dir).join(", ")}`,
    ).toBeGreaterThan(0);
  });

  it("assumes each scanned package's build task does not execute application code", () => {
    // This scan only requires reads to be declared in turbo.json's `test` task
    // because `test` is the ONLY task that actually runs this source — build
    // is a pure compile for every package listed here. If a package's build
    // script stops being that (a bundler that server-renders, a codegen step
    // that imports app code), this fails loudly instead of leaving reads that
    // now execute at build time unchecked against build.env.
    const wrong: string[] = [];
    for (const pkg of PACKAGES) {
      const pkgJson = JSON.parse(
        readFileSync(path.join(REPO_ROOT, pkg.dir, "package.json"), "utf8"),
      ) as { scripts?: { build?: string } };
      const build = pkgJson.scripts?.build ?? "";
      if (!pkg.expectedBuild.test(build)) {
        wrong.push(
          `${pkg.dir}: build script is \`${build}\`, expected to match ${pkg.expectedBuild}`,
        );
      }
    }
    expect(
      wrong,
      "A scanned package's build script no longer matches the compile-only shape this guard " +
        "assumes. Its process.env reads may now need declaring in turbo.json's build.env too, " +
        "not just test.env:",
    ).toEqual([]);
  });

  it("declares every read variable in turbo.json's test task", () => {
    const declared = new Set(turboTestEnv());
    const undeclared = readVariables.filter((name) => !declared.has(name));
    const examples = undeclared.map((name) => {
      const first = reads.find((r) => r.variable === name);
      return `${name} (e.g. ${first?.file}:${first?.line})`;
    });
    expect(
      examples,
      "Read outside the env module and not declared in turbo.json's test.env. Turbo's strict " +
        "env mode passes through only what a task declares — an undeclared variable reaches " +
        "this code as unset no matter what the shell or CI workflow exports, which is how " +
        "TEST_DATABASE_URL going undeclared let 209 tests skip themselves behind a green " +
        "badge on 2026-08-24 (docs/lessons.md). Add the name to turbo.json's tasks.test.env:",
    ).toEqual([]);
  });
});
