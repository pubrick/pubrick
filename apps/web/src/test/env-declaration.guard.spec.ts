import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The apps/web half of the property `apps/api/src/env-declaration.guard.spec.ts`
 * claims for the backend packages: every `process.env.X` read outside the env
 * module names a variable turbo.json declares for the task that actually
 * executes the code doing the reading. That file scans api, worker,
 * packages/db, packages/ai and packages/shared and stops there, saying so in
 * its own docstring — apps/web "belongs to other work in flight". This file is
 * that work.
 *
 * WHY apps/web IS THE HALF THAT ACTUALLY BIT
 *
 * The second incident in issue #10 happened here, not in the backend:
 * `API_INTERNAL_URL` was read by `next.config.ts` to build the `/api` rewrite
 * and was NOT declared in turbo.json's `build.env`. Turbo's strict env mode
 * stripped it, `next build` took the `?? "http://localhost:3001"` fallback, and
 * the docker image shipped with a rewrite pointing at nothing — a green build,
 * a broken deploy. The name is declared by hand today (with a comment saying
 * why), but until this file existed nothing stopped the NEXT such read from
 * being added undeclared.
 *
 * WHICH TASK A READ IS CHECKED AGAINST
 *
 * The backend guard checks one task (`test`) because every package it scans
 * builds with a pure compiler — `nest build` / `tsup` — so no application code
 * runs at build time and `test` is the only task that executes the source.
 * apps/web is exactly the package where that assumption does not hold:
 * `next build` EVALUATES modules. So a read here is checked against the task
 * that runs it:
 *
 *   - `next.config.*` — read by `next build` (and by `next dev`/`next start`),
 *     never imported by vitest → `build.env`.
 *   - `middleware.*` — bundled for the edge runtime, where Next substitutes
 *     `process.env.X` at build time; the value is frozen into the bundle →
 *     `build.env`. (There is no middleware file today; the rule is written so
 *     that adding one is covered rather than silently unscanned.)
 *   - any `NEXT_PUBLIC_*` read, wherever it appears — Next inlines these into
 *     both the client and server bundles during `next build`, so what the
 *     running app sees is whatever the BUILD process had → `build.env`.
 *   - everything else under `src/` — ordinary server/client module code that
 *     vitest imports and runs → `test.env`.
 *
 * A read declared in NEITHER list fails, naming the file, the line and the task
 * the name has to be added to. The classification is deliberately coarse in one
 * direction only: a server module that is also evaluated during prerender is
 * required in `test.env` and not in `build.env`, because the one such read in
 * the tree today is `NODE_ENV`, which `next build` assigns itself and which no
 * turbo declaration could usefully supply. If a src read ever needs a value at
 * prerender time that only an operator can provide, `build.env` is where it
 * belongs and the honest fix is to widen this rule with the case in front of
 * you — not to file an exemption.
 *
 * WHAT COUNTS AS A "READ", AND WHERE THE ENV-MODULE BOUNDARY SITS
 *
 * Identical to the backend guard, which is why the parsing helpers below are
 * the same shape: `process.env.X` and `process.env["X"]` count anywhere they
 * appear as a value; a plain `process.env.X = v` write and `delete
 * process.env.X` do not (they do not consume the current value); a computed key
 * `process.env[name]` has no fixed name to declare. A file named `env.ts` is
 * excluded by filename — apps/web has no env module today, and the exclusion is
 * stated so that adding one (a zod `parseEnv` shape, which fails loud on a
 * missing variable, the opposite failure shape from the one guarded here) does
 * not need this file rewritten. The two guards are kept as separate files with
 * duplicated helpers on purpose: they scan different trees against different
 * turbo tasks and must be free to change independently.
 *
 * A file this scan cannot parse is a FAILURE here, not an omission: a scanner
 * that drops what it cannot classify reads identically to "nothing to report"
 * (docs/lessons.md, 2026-09-02).
 */

const REPO_ROOT = repoRoot();
const WEB_DIR = "apps/web";
const SELF = "env-declaration.guard.spec.ts";
const ENV_MODULE_BASENAME = "env.ts";
const SKIP_DIRS = new Set(["node_modules", "dist", ".next", ".turbo", "coverage"]);

/** Task names as they appear in turbo.json. */
type Task = "build" | "test";

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

/** `next.config.*` and `middleware.*` sit at the package root, beside src, and
 *  are matched by name rather than by directory: both are evaluated by
 *  `next build`, and neither is reachable from a recursive walk of `src/`. */
function configFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!/^(next\.config|middleware)\.[cm]?[jt]sx?$/.test(entry.name)) continue;
    found.push(path.join(dir, entry.name));
  }
  return found;
}

/** Every file this guard scans: the whole of src, plus the package-root
 *  config/middleware files Next evaluates at build. */
function scannedFiles(): string[] {
  const root = path.join(REPO_ROOT, WEB_DIR);
  return [
    ...sourceFiles(path.join(root, "src")),
    ...configFiles(root),
    ...configFiles(path.join(root, "src")),
  ];
}

type EnvRead = { file: string; line: number; text: string; variable: string; task: Task };
type Problem = { file: string; line: number; text: string; reason: string };

function isProcessEnv(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "process" &&
    node.name.text === "env"
  );
}

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

/** Which turbo task actually executes this read — see the docstring. */
function taskFor(relFile: string, variable: string): Task {
  const base = path.basename(relFile);
  if (/^(next\.config|middleware)\./.test(base)) return "build";
  if (variable.startsWith("NEXT_PUBLIC_")) return "build";
  return "test";
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
      reads.push({
        file: rel,
        line: at(node),
        text: excerpt(node, source),
        variable: target.name,
        task: taskFor(rel, target.name),
      });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
}

function collectReads(): { reads: EnvRead[]; problems: Problem[] } {
  const reads: EnvRead[] = [];
  const problems: Problem[] = [];
  for (const file of scannedFiles()) {
    inspect(file, path.relative(REPO_ROOT, file), reads, problems);
  }
  return { reads, problems };
}

const { reads, problems } = collectReads();

/**
 * turbo.json is JSONC — it carries explanatory `//` comments, and its own
 * `$schema` value contains a `//`, so a bare comment-stripping regex would
 * corrupt that URL. Same routine as the backend guard's, kept local for the
 * same reason the rest of this file is: no dependency on that file's internals.
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

function turboEnv(): Record<Task, string[]> {
  const config = JSON.parse(
    stripJsonComments(readFileSync(path.join(REPO_ROOT, "turbo.json"), "utf8")),
  ) as { tasks?: { build?: { env?: string[] }; test?: { env?: string[] } } };
  return {
    build: config.tasks?.build?.env ?? [],
    test: config.tasks?.test?.env ?? [],
  };
}

function webPackageJson(): { scripts?: Record<string, string> } {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, WEB_DIR, "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
}

describe("every process.env read in apps/web is declared for the task that runs it", () => {
  it("finds source files to scan — a scan that matches nothing is a green light for anything", () => {
    expect(scannedFiles().length).toBeGreaterThan(20);
  });

  it("scans the package-root files Next evaluates at build", () => {
    // next.config.ts is where the API_INTERNAL_URL incident happened, and it is
    // the one file a recursive walk of src/ would never reach. If the walk
    // above stops finding it — renamed, moved, converted to .mjs — this fails
    // rather than quietly guarding one file fewer.
    const scanned = scannedFiles().map((f) => path.relative(REPO_ROOT, f));
    expect(scanned).toContain(`${WEB_DIR}/next.config.ts`);
  });

  it("parses every scanned file", () => {
    expect(
      problems.map((p) => `${p.file}:${p.line}: ${p.reason} — ${p.text}`),
      "A file this scan cannot parse yields no reads, which reads identically to a file " +
        "with nothing to guard — so it is a failure here instead:",
    ).toEqual([]);
  });

  it("finds process.env reads to guard — a scan that matches nothing proves nothing below it", () => {
    expect(reads.length, `no process.env read found under ${WEB_DIR}`).toBeGreaterThanOrEqual(2);
  });

  it("exercises both the build-time and the test-time branch of the rule", () => {
    // The two classifications are the whole content of this guard. If the tree
    // ever holds only one kind of read, the other branch is unexercised and its
    // failure message is an untested claim — say so here rather than let the
    // suite report a rule it did not run.
    expect(
      reads.filter((r) => r.task === "build").map((r) => `${r.variable} (${r.file}:${r.line})`),
      "no read classified as build-time",
    ).not.toEqual([]);
    expect(
      reads.filter((r) => r.task === "test").map((r) => `${r.variable} (${r.file}:${r.line})`),
      "no read classified as test-time",
    ).not.toEqual([]);
  });

  it("assumes next build evaluates this package's code and vitest runs it", () => {
    // The split above is justified by two facts about apps/web's scripts: the
    // build is `next build`, which EVALUATES modules (unlike the backend
    // packages' pure `tsup`/`nest build` compile, which is why the sibling
    // guard checks a single task), and the test script is vitest, which imports
    // and runs the module graph. If either stops being true, the task a read is
    // attributed to may be wrong, and that is a loud failure, not a silent one.
    const scripts = webPackageJson().scripts ?? {};
    expect(scripts.build, "apps/web build script").toMatch(/\bnext build\b/);
    expect(scripts.test, "apps/web test script").toMatch(/\bvitest\b/);
  });

  it("declares every read variable in the turbo task that executes it", () => {
    const declared = turboEnv();
    const undeclared = reads
      .filter((read) => !declared[read.task].includes(read.variable))
      .map(
        (read) =>
          `${read.variable} — read at ${read.file}:${read.line} (${read.text}), ` +
          `add it to turbo.json's tasks.${read.task}.env`,
      );
    expect(
      [...new Set(undeclared)].sort(),
      "Read in apps/web and not declared for the turbo task that runs it. Strict env mode " +
        "passes a task ONLY the variables it declares, so an undeclared name arrives as " +
        "unset whatever the shell or the CI workflow exports — which is how API_INTERNAL_URL " +
        "went missing from build.env and baked a localhost:3001 /api rewrite into a green " +
        "docker image (issue #10). `next.config.*`, `middleware.*` and every NEXT_PUBLIC_* " +
        "read are evaluated by `next build` and belong in tasks.build.env; the rest of src " +
        "is run by vitest and belongs in tasks.test.env:",
    ).toEqual([]);
  });
});
