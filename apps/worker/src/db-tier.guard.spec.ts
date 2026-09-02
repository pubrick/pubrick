import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createDb } from "@pubrick/db";
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
 * What this file asserts, and why it is stronger than "TEST_DATABASE_URL is set":
 *
 *  1. It DISCOVERS the gates rather than assuming them — it reads this package's own spec
 *     files and extracts every `skipIf`/`runIf` condition. A gate whose condition it cannot
 *     resolve to an environment variable, or one keyed on a variable not listed in
 *     GATE_VARIABLES, fails here. No future gate can exist that this guard does not know
 *     about; that is the part that closes the class instead of the instance.
 *
 *  2. It requires turbo.json to declare those variables (plus CI, which this guard itself
 *     depends on). Strict env mode strips whatever is undeclared, so an undeclared variable
 *     is the original bug — and until now nothing but a line in CLAUDE.md enforced it. This
 *     check runs on every invocation, CI or not.
 *
 *  3. Under CI, every discovered gate variable must be present. A gate that is open cannot
 *     skip its suite, and by (1) there are no gates this guard has not seen — so this is an
 *     assertion about the mechanism, which holds for every run, rather than a skipped-count
 *     assertion about one run.
 *
 *  4. Whenever the URL is set it looks at the DATABASE rather than at the configuration: the
 *     migration barrier in vitest.global-setup.ts must have left an applied-migration trail.
 *     This is the only check here that observes the tier actually running, and it turns "the
 *     whole e2e suite exploded" into one sentence naming the barrier that did not run.
 *
 * Running the unit tier without a database stays legitimate: off CI, a missing variable
 * prints a notice naming exactly what will not run, and passes.
 */

/**
 * Environment variables this package's suites may be gated on. A new env-gated suite
 * declares its variable here AND in turbo.json's `test.env` — check 2 enforces the pair.
 */
const GATE_VARIABLES: readonly string[] = ["TEST_DATABASE_URL"];

/** Vitest's cwd is the package root under both `pnpm --filter …` and turbo. */
const SRC = path.resolve(process.cwd(), "src");
/** This guard is not one of the gates it inspects. Matched by prefix so the copies of this
 *  file in the other packages stay byte-identical regardless of their .spec/.test suffix. */
const SELF = "db-tier.guard";
const SPEC_SUFFIXES = [".spec.ts", ".spec.tsx", ".test.ts", ".test.tsx"];

/** `describe.skipIf(<condition>)` and its `it`/`test` and `runIf` variants. */
const GATE = /\b(?:describe|it|test)\s*\.\s*(?:skipIf|runIf)\s*\(([^)]*)\)/g;
/** `const url = process.env.TEST_DATABASE_URL` — the identifier a gate is written against. */
const DECLARATION = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*process\.env\.([A-Z0-9_]+)/g;

type Gate = { file: string; condition: string; variable: string | null };

function specFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      found.push(...specFiles(full));
    } else if (
      !entry.name.startsWith(SELF) &&
      SPEC_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))
    ) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Resolves a gate condition to the variable behind it. Two shapes are understood:
 * `!process.env.X`, and `!ident` where the file declares `const ident = process.env.X`.
 * Anything else resolves to null and fails check 1 — deliberately fail-safe, because
 * "the scanner did not recognise that one" is exactly how a silent skip gets back in.
 */
function gateVariable(source: string, condition: string): string | null {
  const trimmed = condition.trim();
  const inline = /^!\s*process\.env\.([A-Z0-9_]+)$/.exec(trimmed);
  if (inline?.[1]) return inline[1];
  const named = /^!\s*([A-Za-z_$][\w$]*)$/.exec(trimmed);
  if (!named?.[1]) return null;
  for (const [, identifier, variable] of source.matchAll(DECLARATION)) {
    if (identifier === named[1] && variable) return variable;
  }
  return null;
}

const gates: Gate[] = specFiles(SRC).flatMap((file) => {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(GATE)].map((match) => ({
    file: path.relative(SRC, file),
    condition: (match[1] ?? "").trim(),
    variable: gateVariable(source, match[1] ?? ""),
  }));
});

const gatedFiles = [...new Set(gates.map((gate) => gate.file))].sort();
const gatedOn = [...new Set(gates.map((gate) => gate.variable).filter((v) => v !== null))].sort();

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
  let dir = process.cwd();
  while (!existsSync(path.join(dir, "turbo.json"))) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`No turbo.json above ${process.cwd()}`);
    dir = parent;
  }
  const config = JSON.parse(
    stripJsonComments(readFileSync(path.join(dir, "turbo.json"), "utf8")),
  ) as { tasks?: { test?: { env?: string[] } } };
  return config.tasks?.test?.env ?? [];
}

const DARK = `${gatedFiles.length} gated spec file(s) would skip themselves and the run would still exit 0`;

describe("database tier guard", () => {
  it("finds the conditional-skip gates it exists to guard", () => {
    // A scanner that quietly matches nothing makes every assertion below vacuous — the same
    // failure mode one level up. If this package genuinely has no env-gated suite left,
    // delete this file deliberately rather than letting it pass on emptiness.
    expect(gates.length, `no skipIf/runIf gate found under ${SRC}`).toBeGreaterThan(0);
  });

  it("keys every gate on a declared environment variable", () => {
    const unreadable = gates
      .filter((gate) => gate.variable === null)
      .map((gate) => `${gate.file}: skipIf(${gate.condition})`);
    expect(
      unreadable,
      "Skip gate written in a shape this guard cannot read, so it cannot be checked. " +
        "Write it as `skipIf(!process.env.X)` or `const x = process.env.X; skipIf(!x)`, " +
        "or teach gateVariable() the new shape:",
    ).toEqual([]);

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

  it("runs against a database the migration barrier has actually migrated", async () => {
    const url = process.env.TEST_DATABASE_URL;
    // Whether being unset is allowed at all is the previous test's job, not this one's.
    if (!url) return;
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
