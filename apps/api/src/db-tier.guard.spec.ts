import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The database tier's dead-man switch — the one spec in this package that cannot skip.
 *
 * Every database-backed suite here is gated on `describe.skipIf(!url)`, and a skipped test
 * still exits 0. On 2026-08-24 that turned CI green over a tier that never ran (see
 * docs/lessons.md): turbo's strict env mode stripped an undeclared TEST_DATABASE_URL, the
 * gate read as closed, and the suites skipped themselves in silence. Declaring that one
 * variable closed the instance and left the class open — a renamed CI secret, a postgres
 * service that fails its health check, or the next env-gated suite whose variable nobody
 * declares reopens it, and the badge stays green while every tenancy, publish-gate, fence
 * and ledger test in the product does nothing.
 *
 * THE PROPERTY THIS FILE CLAIMS
 *
 *   Every spec file in this package is classified, by an actual parse of its syntax tree,
 *   into exactly one of two states: it runs unconditionally, or it runs only when a named
 *   environment variable — listed in GATE_VARIABLES here and declared in turbo.json's
 *   test.env — is set. Any construct that could stop a suite from running and that the
 *   classifier cannot place in the second state fails this guard, naming the file, the line
 *   and the source text. The classifier's input is the file's whole syntax tree, not the
 *   subset some pattern happened to match, so there is no shape it can fail to look at.
 *
 * That second sentence is the repair. Until 2026-09-02 discovery was a regular expression,
 * `/\b(?:describe|it|test)\s*\.\s*(?:skipIf|runIf)\s*\(([^)]*)\)/`, and the file's fail-safe
 * covered the CONDITION it found rather than the DISCOVERY that finds conditions. A gate the
 * expression did not match was not reported unreadable — it was simply not in the set, and
 * the guard passed. `suite.skipIf(...)`, `describe.concurrent.skipIf(...)`, a condition
 * containing a nested paren or a line break, a describe wrapped in a helper, an `if` at
 * module scope: every one of them walked straight past the alarm built to catch them.
 * Nothing on the branch had escaped yet; the next test written could have.
 *
 * WHAT IS CHECKED, in the order the tests below assert it
 *
 *  1. Every spec file in this package parses. A file the parser cannot read is named and
 *     fails, rather than being scanned as text and quietly yielding no gates.
 *
 *  2. The scan is not vacuous: this package still has at least one gate to guard.
 *
 *  3. Nothing in a spec file could stop a suite from running except a resolved gate. Three
 *     sweeps over the tree, all fail-closed — an unrecognised construct is a failure, never
 *     an omission:
 *       - every `.skipIf`/`.runIf` call, whatever its receiver chain, must sit on a vitest
 *         runner and carry a condition that resolves to one environment variable;
 *       - `.skip`, `.only` and `.todo` disable a suite with no condition at all, so they are
 *         refused outright — `.only` in particular silences everything around it;
 *       - at module scope, no control flow and no call to anything but a known vitest entry
 *         point, because a suite registered through a helper is a suite this guard cannot
 *         see. Computed access on a runner (`describe[flag]`) is refused for the same reason.
 *
 *  4. Every gate keys on a variable listed in GATE_VARIABLES.
 *
 *  5. turbo.json declares those variables (plus CI, which this guard itself depends on).
 *     Strict env mode strips whatever is undeclared, so an undeclared variable is the
 *     original bug — and until now nothing but a line in CLAUDE.md enforced it. This check
 *     runs on every invocation, CI or not.
 *
 *  6. Under CI, every discovered gate variable must be present. A gate that is open cannot
 *     skip its suite, and by (1)–(3) there are no gates this guard has not seen — so this is
 *     an assertion about the mechanism, which holds for every run, rather than a
 *     skipped-count assertion about one run.
 *
 *  7. The three copies of this guard are byte-identical over their shared region, and the
 *     set of copies is exactly COPIES.
 *
 *  8. Every package that gates a suite on an environment variable owns a copy.
 *
 * WHY THREE COPIES AND NOT A SHARED HELPER
 *
 * A helper would have to live somewhere every database-owning package can import from.
 * packages/db is the leaf the other two depend on and has no workspace dependency of its
 * own; putting the helper in @pubrick/shared would invert that edge, and a fourth package
 * existing only to hold one test helper is worse than what it replaces. So the copies stay —
 * and check 7 makes the duplication self-policing. Editing one copy and not the others is
 * now a named failure in all three packages instead of silent drift, which is the only cost
 * duplication actually has here.
 *
 * WHAT THIS GUARD STILL DOES NOT SEE
 *
 * It reads spec files. A suite can also be prevented from running from outside them — a
 * vitest.config.ts `exclude` pattern, a `testNamePattern`, a globalSetup that throws, a spec
 * file deleted outright. Those are visible in the run's own file count and are not this
 * file's subject; it is worth knowing the boundary rather than believing the guard covers
 * everything.
 *
 * Running the unit tier without a database stays legitimate: off CI, a missing variable
 * prints a notice naming exactly what will not run, and passes.
 */

/**
 * Environment variables this package's suites may be gated on. A new env-gated suite
 * declares its variable here AND in turbo.json's `test.env` — check 5 enforces the pair.
 */
const GATE_VARIABLES: readonly string[] = ["TEST_DATABASE_URL"];

/** Vitest's cwd is the package root under both `pnpm --filter …` and turbo. */
const SRC = path.resolve(process.cwd(), "src");
/** This guard is not one of the gates it inspects. Matched by prefix so the copies of this
 *  file in the other packages stay byte-identical regardless of their .spec/.test suffix. */
const SELF = "db-tier.guard";
const SPEC_SUFFIXES = [".spec.ts", ".spec.tsx", ".test.ts", ".test.tsx"];

/** Every copy of this guard, relative to the repo root. Check 7 asserts the census, and
 *  compares every copy's shared region against the reference copy's. */
const REFERENCE_COPY = "apps/api/src/db-tier.guard.spec.ts";
const COPIES: readonly string[] = [
  REFERENCE_COPY,
  "apps/worker/src/db-tier.guard.spec.ts",
  "packages/db/src/db-tier.guard.test.ts",
];

/** Vitest entry points a gate can hang off, and the only receivers a gate may use. */
const RUNNERS = new Set(["describe", "it", "test", "suite", "bench"]);
/** What a spec file may CALL at module scope. Anything else could register a suite. */
const MODULE_SCOPE_CALLS = new Set([
  ...RUNNERS,
  "beforeAll",
  "afterAll",
  "beforeEach",
  "afterEach",
  "expect",
  "vi",
  "vitest",
]);
/** Conditional gates: allowed, but only in a shape that resolves to one variable. */
const GATING = new Set(["skipIf", "runIf"]);
/** Unconditional disablers: no condition to resolve, so never allowed in a spec file. */
const DISABLING = new Set(["skip", "only", "todo"]);
/** Statements that branch. At module scope any of them can decide whether suites register. */
const BRANCHING = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.SwitchStatement,
  ts.SyntaxKind.TryStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.ReturnStatement,
  ts.SyntaxKind.ThrowStatement,
  ts.SyntaxKind.LabeledStatement,
  ts.SyntaxKind.WithStatement,
  ts.SyntaxKind.BreakStatement,
  ts.SyntaxKind.ContinueStatement,
]);

type Gate = { file: string; line: number; text: string; variable: string };
type Problem = { file: string; line: number; text: string; reason: string };

function specFiles(dir: string, includeGuard = false): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      found.push(...specFiles(full, includeGuard));
    } else if (
      (includeGuard || !entry.name.startsWith(SELF)) &&
      SPEC_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))
    ) {
      found.push(full);
    }
  }
  return found;
}

function repoRoot(): string {
  let dir = process.cwd();
  while (!existsSync(path.join(dir, "turbo.json"))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`No turbo.json above ${process.cwd()}`);
    dir = parent;
  }
  return dir;
}

/** The identifier a member/call chain hangs off: `describe.concurrent.skipIf(x)` → describe. */
function rootIdentifier(node: ts.Node): string | null {
  let current = node;
  for (;;) {
    if (ts.isIdentifier(current)) return current.text;
    if (
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current) ||
      ts.isCallExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return null;
  }
}

/** `process.env.X` → "X". Anything else → null. */
function envRead(node: ts.Node): string | null {
  if (!ts.isPropertyAccessExpression(node)) return null;
  const inner = node.expression;
  if (!ts.isPropertyAccessExpression(inner)) return null;
  if (!ts.isIdentifier(inner.expression) || inner.expression.text !== "process") return null;
  if (inner.name.text !== "env") return null;
  return node.name.text;
}

/** Module-scope `const ident = process.env.X` bindings, the indirection a gate may use. */
function envBindings(source: ts.SourceFile): Map<string, string> {
  const bindings = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const variable = envRead(declaration.initializer);
      if (variable) bindings.set(declaration.name.text, variable);
    }
  }
  return bindings;
}

/**
 * The variable behind a gate condition. Exactly two shapes are understood: `!process.env.X`,
 * and `!ident` where the file binds `const ident = process.env.X` at module scope. Anything
 * else resolves to null and fails check 3 — deliberately fail-closed, because "the scanner
 * did not recognise that one" is exactly how a silent skip gets back in.
 */
function gateVariable(condition: ts.Node, bindings: Map<string, string>): string | null {
  if (!ts.isPrefixUnaryExpression(condition)) return null;
  if (condition.operator !== ts.SyntaxKind.ExclamationToken) return null;
  const direct = envRead(condition.operand);
  if (direct) return direct;
  if (ts.isIdentifier(condition.operand)) return bindings.get(condition.operand.text) ?? null;
  return null;
}

function excerpt(node: ts.Node, source: ts.SourceFile): string {
  const text = node.getText(source).replace(/\s+/gu, " ");
  return text.length > 96 ? `${text.slice(0, 93)}…` : text;
}

/** Parses one spec file and appends what it found to `gates` and what it refuses to `problems`. */
function inspect(file: string, rel: string, gates: Gate[], problems: Problem[]): void {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const at = (node: ts.Node): number =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const flag = (node: ts.Node, reason: string): void => {
    problems.push({ file: rel, line: at(node), text: excerpt(node, source), reason });
  };

  // A file the parser could not read must SAY so. Scanning it anyway would yield no gates
  // and read as "nothing to guard here" — the exact failure this rewrite exists to remove.
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

  const bindings = envBindings(source);

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      const name = node.name.text;
      if (DISABLING.has(name)) {
        flag(node, `\`.${name}\` stops a suite with no condition to check`);
      } else if (GATING.has(name)) {
        const parent = node.parent;
        const called = parent && ts.isCallExpression(parent) && parent.expression === node;
        const receiver = rootIdentifier(node.expression);
        if (!called) {
          flag(node, `\`.${name}\` is referenced but not called, so its condition is unknown`);
        } else if (receiver === null || !RUNNERS.has(receiver)) {
          flag(node, `\`.${name}\` on \`${receiver ?? "an expression"}\`, which is not a runner`);
        } else {
          const condition = parent.arguments[0];
          const variable = condition ? gateVariable(condition, bindings) : null;
          if (variable === null) {
            flag(parent, "gate condition does not resolve to one environment variable");
          } else {
            gates.push({ file: rel, line: at(parent), text: excerpt(parent, source), variable });
          }
        }
      }
    } else if (ts.isElementAccessExpression(node)) {
      const receiver = rootIdentifier(node.expression);
      if (receiver !== null && RUNNERS.has(receiver)) {
        flag(node, "computed member access on a runner hides which modifier is applied");
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);

  for (const statement of source.statements) {
    if (BRANCHING.has(statement.kind)) {
      flag(statement, "control flow at module scope can decide whether suites register");
      continue;
    }
    if (!ts.isExpressionStatement(statement)) continue;
    let expression: ts.Node = statement.expression;
    while (
      ts.isAwaitExpression(expression) ||
      ts.isVoidExpression(expression) ||
      ts.isParenthesizedExpression(expression) ||
      ts.isNonNullExpression(expression) ||
      ts.isAsExpression(expression)
    ) {
      expression = expression.expression;
    }
    if (!ts.isCallExpression(expression)) continue;
    const root = rootIdentifier(expression.expression);
    if (root === null || !MODULE_SCOPE_CALLS.has(root)) {
      flag(
        statement,
        `module-scope call to \`${root ?? "an expression"}\`: a suite registered through a ` +
          "helper is a suite this guard cannot see",
      );
    }
  }
}

const specs = specFiles(SRC);
const gates: Gate[] = [];
const problems: Problem[] = [];
for (const file of specs) inspect(file, path.relative(SRC, file), gates, problems);

const gatedFiles = [...new Set(gates.map((gate) => gate.file))].sort();
const gatedOn = [...new Set(gates.map((gate) => gate.variable))].sort();
const unparsed = problems
  .filter((problem) => problem.reason.startsWith("does not parse"))
  .map((problem) => `${problem.file}:${problem.line}: ${problem.text}`);
const refused = problems.map(
  (problem) => `${problem.file}:${problem.line}: ${problem.reason} — ${problem.text}`,
);

/**
 * turbo.json is JSONC — it carries explanatory `//` comments, and its own `$schema` value
 * contains a `//`. Stripping comments with a bare regex would corrupt that URL, so this
 * walks the text once, tracking string state, and removes only real comments.
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
    stripJsonComments(readFileSync(path.join(repoRoot(), "turbo.json"), "utf8")),
  ) as { tasks?: { test?: { env?: string[] } } };
  return config.tasks?.test?.env ?? [];
}

/**
 * The marker closing the region every copy shares. It appears twice in each copy — here, in
 * this declaration, and as the real marker at the end of the region — so lastIndexOf() is
 * what picks the real one. Both occurrences are inside the region and therefore identical
 * everywhere, which is what makes that safe.
 */
const REGION_END = "// --- end of the region every copy of this guard shares, byte for byte ---";

function sharedRegion(text: string, label: string): string {
  const end = text.lastIndexOf(REGION_END);
  if (end < 0) throw new Error(`${label} carries no shared-region marker`);
  return text.slice(0, end);
}

/** Every db-tier.guard.* file in the workspace, relative to the repo root. */
function guardCensus(root: string): string[] {
  const found: string[] = [];
  for (const group of ["apps", "packages"]) {
    const groupDir = path.join(root, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      const src = path.join(groupDir, entry.name, "src");
      if (!entry.isDirectory() || !existsSync(src)) continue;
      for (const file of specFiles(src, true)) {
        if (path.basename(file).startsWith(SELF)) found.push(path.relative(root, file));
      }
    }
  }
  return found.sort();
}

/**
 * Packages whose spec files so much as mention a gate. Deliberately a crude token match, and
 * deliberately over-broad: a false positive here costs a package one copy of this guard,
 * whereas a false negative costs a whole tier its alarm. That is the opposite direction from
 * the regex this rewrite removed, which was over-NARROW in a place where a miss meant silence.
 */
function packagesWithGates(root: string): string[] {
  const found: string[] = [];
  for (const group of ["apps", "packages"]) {
    const groupDir = path.join(root, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      const src = path.join(groupDir, entry.name, "src");
      if (!entry.isDirectory() || !existsSync(src)) continue;
      const gated = specFiles(src).some((file) =>
        /\b(?:skipIf|runIf)\b/u.test(readFileSync(file, "utf8")),
      );
      if (gated) found.push(`${group}/${entry.name}`);
    }
  }
  return found.sort();
}

const DARK = `${gatedFiles.length} gated spec file(s) would skip themselves and the run would still exit 0`;

describe("database tier guard", () => {
  it("parses every spec file in this package", () => {
    expect(specs.length, `no spec file found under ${SRC}`).toBeGreaterThan(0);
    expect(
      unparsed,
      "This guard reads its package's spec files as syntax trees. A file it cannot parse " +
        "yields no gates, which reads identically to a file with nothing to guard — so it " +
        "is a failure here instead:",
    ).toEqual([]);
  });

  it("finds the conditional-skip gates it exists to guard", () => {
    // A scanner that quietly matches nothing makes every assertion below vacuous — the same
    // failure mode one level up. If this package genuinely has no env-gated suite left,
    // delete this file deliberately rather than letting it pass on emptiness.
    expect(gates.length, `no skipIf/runIf gate found under ${SRC}`).toBeGreaterThan(0);
  });

  it("refuses every construct that could stop a suite it cannot account for", () => {
    expect(
      refused,
      "Something in a spec file could stop a suite from running, and this guard cannot " +
        "resolve it to an environment variable — so it cannot promise the suite ran. Write " +
        "the gate as `describe.skipIf(!process.env.X)` or `const x = process.env.X; " +
        "describe.skipIf(!x)`, register suites by calling a runner directly rather than " +
        "through a helper, keep module scope free of branches, and delete `.skip`/`.only`/" +
        "`.todo`. If a new shape is genuinely needed, teach inspect() to resolve it — never " +
        "widen the exceptions here:",
    ).toEqual([]);
  });

  it("keys every gate on a declared environment variable", () => {
    const undeclared = gatedOn.filter((name) => !GATE_VARIABLES.includes(name));
    expect(
      undeclared,
      "New environment variable gating a suite. Add it to GATE_VARIABLES here and to " +
        "turbo.json's test.env, or turbo's strict env mode will strip it and the suite " +
        "will skip in silence:",
    ).toEqual([]);
  });

  it("is declared in turbo.json, along with every variable it gates on", () => {
    const declared = new Set(turboTestEnv());
    // CI is listed because this guard reads it: an undeclared CI would be stripped by the
    // same strict env mode, the guard would take its friendly local branch inside CI, and
    // the trap would be rebuilt inside its own alarm.
    const missing = ["CI", ...gatedOn].filter((name) => !declared.has(name));
    expect(
      missing,
      "Not declared in turbo.json's test.env. Turbo's strict env mode passes through only " +
        "what a task declares, so these reach the test process as unset no matter what the " +
        "shell or the workflow exports — the 2026-08-24 failure exactly:",
    ).toEqual([]);
  });

  it("has every gate open whenever CI is set", () => {
    const missing = gatedOn.filter((name) => !process.env[name]);
    if (!process.env.CI) {
      // A developer running the unit tier without a database is doing something legitimate.
      // Say plainly what will not run, and pass.
      if (missing.length > 0) {
        console.warn(
          `\n[db-tier guard] Database tier OFF: ${missing.join(", ")} not set.\n` +
            `  Skipping ${gatedFiles.length} gated spec file(s): ${gatedFiles.join(", ")}\n` +
            "  Fine for a unit-only run. Set TEST_DATABASE_URL to a pgvector Postgres to " +
            "include them.\n  Under CI this same state is a hard failure.\n",
        );
      }
      return;
    }
    expect(
      missing,
      `CI is set but the database tier is dark — ${DARK}. Check, in order: the workflow's ` +
        "env/secrets for these names, the postgres service's health check, and turbo.json's " +
        "test.env. Missing:",
    ).toEqual([]);
  });

  it("is byte-identical to its copies in the other database-owning packages", () => {
    const root = repoRoot();
    expect(
      guardCensus(root),
      "A copy of this guard appeared or vanished. Every copy is checked against every " +
        "other, so an undeclared one would police nobody; update COPIES in all of them:",
    ).toEqual([...COPIES].sort());

    const reference = sharedRegion(
      readFileSync(path.join(root, REFERENCE_COPY), "utf8"),
      REFERENCE_COPY,
    );
    const drifted = COPIES.filter(
      (copy) => sharedRegion(readFileSync(path.join(root, copy), "utf8"), copy) !== reference,
    );
    expect(
      drifted,
      "Copies of this guard have drifted above the shared-region marker, measured against " +
        `${REFERENCE_COPY}. There is no shared helper on purpose — packages/db is the leaf ` +
        "apps/api and apps/worker depend " +
        "on, so a helper would invert that edge — and this assertion is the price: change " +
        "one copy above the marker, change all three identically. Below the marker they may " +
        "differ (only api and worker have a migration barrier to hold to account):",
    ).toEqual([]);
  });

  it("exists in every package that gates a suite on an environment variable", () => {
    const root = repoRoot();
    const owned = new Set(COPIES.map((copy) => copy.split("/").slice(0, 2).join("/")));
    const unguarded = packagesWithGates(root).filter((pkg) => !owned.has(pkg));
    expect(
      unguarded,
      "This package gates suites on an environment variable and has no copy of this guard, " +
        "so nothing would notice its tier going dark. Copy the shared region of " +
        `${REFERENCE_COPY} into <package>/src/db-tier.guard.spec.ts, and add its path to ` +
        "COPIES in every copy:",
    ).toEqual([]);
  });
});
// --- end of the region every copy of this guard shares, byte for byte ---

/**
 * The one check here that looks at the DATABASE rather than at the configuration: whenever
 * the URL is set, the migration barrier in vitest.global-setup.ts must have left an
 * applied-migration trail. It turns "the whole e2e suite exploded" into one sentence naming
 * the barrier that did not run.
 *
 * packages/db has no such barrier — migrate.test.ts migrates as part of what it is testing,
 * and works on throwaway databases — so its copy of this guard ends at the marker above.
 */
describe("database tier guard: migration barrier", () => {
  it("runs against a database the migration barrier has actually migrated", async () => {
    const url = process.env.TEST_DATABASE_URL;
    // Whether being unset is allowed at all is the CI check's job, not this one's.
    if (!url) return;
    // Imported here rather than at the top of the file so that the region above can stay
    // byte-identical in packages/db, which cannot import itself.
    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url);
    try {
      const table = await db.execute(
        "SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present",
      );
      expect(
        table.rows[0]?.present,
        "TEST_DATABASE_URL points at a database with no applied-migration trail: " +
          "vitest.global-setup.ts's runMigrations() barrier did not run against this URL. " +
          "Every e2e spec below is about to fail for reasons that will look like its own.",
      ).toBe(true);
      const applied = await db.execute(
        'SELECT count(*)::int AS n FROM drizzle."__drizzle_migrations"',
      );
      expect(
        Number(applied.rows[0]?.n),
        "No migrations applied to TEST_DATABASE_URL",
      ).toBeGreaterThan(0);
    } finally {
      await pool.end();
    }
  });
});
