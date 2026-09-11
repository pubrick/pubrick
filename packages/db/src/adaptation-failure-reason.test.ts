import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * THE RATCHET UNDER `adaptations.failure_reason`.
 *
 * The column is only worth reading if it is never stale, and "never stale" is a
 * property of the WRITERS, not of the column: a nullable code written by one
 * branch and cleared by none would leave `schedule_missed` standing beside a
 * decryption sentence, and the screen would caption a credentials failure
 * "Missed its slot". That is the same defect `apps/web/src/lib/adaptations.ts`
 * already carries a note about, one column over.
 *
 * So every statement in the product that sets `adaptations.status` must also
 * name `failureReason` — writing a code, or writing `null` beside the
 * `lastError` it already clears. A new writer that forgets fails HERE, naming
 * itself, rather than shipping a row whose code describes a verdict it no longer
 * has.
 *
 * WHY A SCAN AND NOT A TYPE. drizzle's `.set()` takes a Partial, so there is no
 * compiler seat for "this field is required when that one is present", and the
 * only alternative — funnelling every write through one helper — is a bigger
 * change than the invariant is worth and would still admit a caller that went
 * round it. A scan of the real source is what the repo already does for the
 * env-declaration and db-tier guards, with their rule: a scanner that silently
 * drops what it cannot classify reads exactly like "nothing to report", so this
 * one asserts it found something before it asserts anything about what it found.
 *
 * WHAT THE SCAN DOES NOT SEE. It reads the QUERY BUILDER — a `.set()` on a
 * chain that ran `.update(schema.adaptations)` — and nothing else. A writer
 * that reached this table through raw `sql\`update …\`` or `db.execute` would be
 * invisible to it. That gap is theoretical today rather than tolerated: every
 * raw statement in `apps/` and `packages/` was read, and no production writer
 * of this table goes round the builder. A future one would have to be caught in
 * review.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

/** The trees a production writer of this table can live in. */
const ROOTS = ["apps", "packages"];

/**
 * Test files are NOT scanned, and that is a decision rather than convenience.
 *
 * Specs write this table directly to stage a state the product then acts on —
 * "the row a killed attempt leaves behind", "the row the api re-approved
 * underneath us" — and such a write is a FIXTURE, not a verdict the product
 * reached. Requiring a reason code on them would make the fixtures assert the
 * thing they are inputs to. What keeps THEM honest is the assertions in the
 * specs themselves, which read the column back after the product wrote it.
 */
const TEST_FILE = /\.(spec|test)\.tsx?$/;

/**
 * Writers that set `status` and deliberately do NOT touch `failureReason`, each
 * with the reason. Empty today, and the list exists so that the next one has to
 * be argued in a pull request instead of discovered on a screen.
 */
const EXEMPT: ReadonlyArray<{ file: string; line: string; why: string }> = [];

type Write = { file: string; line: number; text: string; hasFailureReason: boolean };

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".next") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(entry) || TEST_FILE.test(entry)) continue;
    out.push(full);
  }
  return out;
}

/**
 * Every `.update(schema.adaptations)` whose `.set({ … })` names `status`.
 *
 * PARSED, NOT MATCHED. This began as a regex over the `.set({ … })` slice with
 * a brace counter for its end, and that slice is the whole text — comments
 * included. `// TODO: decide what happens to failureReason: here.` satisfied
 * it, which is the exact shape a writer that forgot the column is likeliest to
 * carry, since the forgetting usually comes with a note about it. Driven twice:
 * deleting `failureReason: null` from `markPublishing` and leaving only that
 * comment passed 3 runs of 3, and the obvious repair — blanking comments with
 * TypeScript's SCANNER before matching — still passed 3 of 3, because
 * `attemptCount: sql\`${…} + 1\`` sits in the same object and a scanner with no
 * parser behind it cannot tell the closing brace of a template substitution
 * from a plain one, mis-reading the rest of the object as one long string.
 *
 * So the question is asked of the syntax tree instead: a property assignment
 * named `failureReason` (written out or shorthand) is a write of the column,
 * and nothing else is one. Comments and template literals are not something
 * this has to reason about — the parser has already put them where they belong.
 *
 * An insert is deliberately not matched: a row born `pending` has no verdict to
 * carry, and the column's default is the null that says so.
 */
function statusWritesIn(text: string, file: string): Write[] {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const writes: Write[] = [];
  const visit = (node: ts.Node): void => {
    const object = setObjectOfAdaptationsUpdate(node);
    if (object && namesProperty(object, "status")) {
      writes.push({
        file,
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        // The RAW slice, comments included, because that is what an EXEMPT entry
        // is written against — a person quotes the line they see in the editor.
        text: node.getText(source),
        hasFailureReason: namesProperty(object, "failureReason"),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return writes;
}

/** `x.set({ … })` whose receiver chain contains `.update(schema.adaptations)`. */
function setObjectOfAdaptationsUpdate(node: ts.Node): ts.ObjectLiteralExpression | null {
  if (!ts.isCallExpression(node)) return null;
  if (!ts.isPropertyAccessExpression(node.expression)) return null;
  if (node.expression.name.text !== "set") return null;
  const [argument] = node.arguments;
  if (!argument || !ts.isObjectLiteralExpression(argument)) return null;
  return updatesAdaptations(node.expression.expression) ? argument : null;
}

/**
 * Walks back down the fluent chain — `db.update(x).set(…)`, and anything a
 * future writer threads in between — looking for the `.update()` this `.set()`
 * belongs to. Stops at the FIRST `.update()` it meets rather than searching
 * past it, so a `.set()` on a chain that updates a different table is not
 * claimed by an `adaptations` update further up.
 */
function updatesAdaptations(node: ts.Expression): boolean {
  let current: ts.Node = node;
  for (;;) {
    if (ts.isCallExpression(current)) {
      const callee = current.expression;
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "update") {
        const [table] = current.arguments;
        return (
          !!table &&
          ts.isPropertyAccessExpression(table) &&
          table.name.text === "adaptations" &&
          ts.isIdentifier(table.expression) &&
          table.expression.text === "schema"
        );
      }
      current = callee;
      continue;
    }
    if (ts.isPropertyAccessExpression(current) || ts.isNonNullExpression(current)) {
      current = current.expression;
      continue;
    }
    return false;
  }
}

/** Written out (`failureReason: null`) or shorthand (`failureReason`). */
function namesProperty(object: ts.ObjectLiteralExpression, name: string): boolean {
  return object.properties.some(
    (property) =>
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === name,
  );
}

function adaptationStatusWrites(): Write[] {
  const writes: Write[] = [];
  for (const root of ROOTS) {
    for (const file of sourceFiles(path.join(repoRoot, root))) {
      writes.push(...statusWritesIn(readFileSync(file, "utf8"), path.relative(repoRoot, file)));
    }
  }
  return writes;
}

/**
 * THE SCANNER ITSELF, against sources this repo does not contain — because the
 * property the file asserts is about what COUNTS as writing the column, and the
 * real writers all happen to write it correctly today. Both mutations that
 * survived the regex version of this scanner are fixtures here, so the repair
 * cannot be undone silently.
 */
describe("a write of the column is a property, and only a property", () => {
  const update = (body: string) =>
    `await db.update(schema.adaptations).set({ status: "failed", ${body} }).where(x);`;

  it("counts a property, written out or shorthand", () => {
    for (const body of [
      "failureReason: null",
      'failureReason: "schedule_missed"',
      "failureReason",
    ]) {
      expect(statusWritesIn(update(body), "f.ts")[0]?.hasFailureReason, body).toBe(true);
    }
  });

  it("does not count a line comment about the column", () => {
    const [write] = statusWritesIn(
      update("// TODO: decide what happens to failureReason: here.\n"),
      "f.ts",
    );
    expect(write?.hasFailureReason).toBe(false);
  });

  it("does not count a block comment about the column", () => {
    expect(
      statusWritesIn(update("/* failureReason: null once lived here */"), "f.ts")[0]
        ?.hasFailureReason,
    ).toBe(false);
  });

  /**
   * The second surviving mutant. A `sql` template beside the column defeated a
   * comment-blanking SCANNER — it cannot tell a substitution's closing brace
   * from a plain one — so the object is parsed instead, and this is the fixture
   * that says the parser is still there.
   */
  it("counts the property with a sql template beside it, and still ignores a comment", () => {
    const withTemplate = (tail: string) =>
      `await db.update(schema.adaptations).set({ status: "publishing", attemptCount: sql\`\${c} + 1\`, ${tail} }).where(x);`;
    expect(statusWritesIn(withTemplate("failureReason: null"), "f.ts")[0]?.hasFailureReason).toBe(
      true,
    );
    expect(
      statusWritesIn(withTemplate("// what happens to failureReason: here?\n"), "f.ts")[0]
        ?.hasFailureReason,
    ).toBe(false);
  });

  it("ignores a .set() on a chain that updates some other table", () => {
    expect(
      statusWritesIn(
        'await db.update(schema.contentItems).set({ status: "failed" }).where(x);',
        "f.ts",
      ),
    ).toEqual([]);
  });

  /** An insert has no verdict to carry; the column's default is the null saying so. */
  it("ignores an insert", () => {
    expect(
      statusWritesIn('await db.insert(schema.adaptations).values({ status: "pending" });', "f.ts"),
    ).toEqual([]);
  });
});

describe("every writer of an adaptation's status answers for its failure reason", () => {
  const writes = adaptationStatusWrites();

  /**
   * The scan has to find the writers we already know about, or every assertion
   * below is vacuous — a renamed import, a moved file or a formatter that
   * reshapes the chain would otherwise turn this whole file green and blind.
   */
  it("finds the status writers it exists to check", () => {
    const files = new Set(writes.map((write) => write.file));
    expect(files).toContain(path.join("apps", "api", "src", "content", "content.repository.ts"));
    expect(files).toContain(path.join("apps", "worker", "src", "publish", "publish.repository.ts"));
    // EIGHT today, counted rather than estimated: three in the api (approve,
    // reject, the delivery resolver) and five in the worker (markPublishing,
    // markPublished, markAlreadyPublished, markFailed, sweepAbandoned). A bare
    // "greater than zero" would survive the scan finding one of them. The bound
    // is deliberately the real count with no headroom — a writer that
    // DISAPPEARS is as much a reason to look as one that arrives, and a new
    // writer raises the number rather than lowering it.
    expect(writes.length).toBeGreaterThanOrEqual(8);
  });

  it("has every one of them write or clear failure_reason", () => {
    const silent = writes
      .filter((write) => !write.hasFailureReason)
      .filter(
        (write) => !EXEMPT.some((row) => write.file === row.file && write.text.includes(row.line)),
      )
      .map((write) => `${write.file}:${write.line}`);
    expect(
      silent,
      "This statement moves an adaptation's status without saying what happens to " +
        "`failureReason`. Write the code that matches the new status, or `failureReason: null` " +
        "beside the `lastError` it clears — a code left behind describes a verdict the row no " +
        "longer has, and the screen captions it. If the write genuinely must not touch the " +
        "column, add it to EXEMPT with the reason:",
    ).toEqual([]);
  });

  /**
   * The exemption list is not a parking space: an entry that no longer matches
   * any real write is an argument nobody can check, and it would silently
   * un-cover the next writer that lands at the same place.
   */
  it("keeps no exemption for a writer that no longer exists", () => {
    const stale = EXEMPT.filter(
      (row) => !writes.some((write) => write.file === row.file && write.text.includes(row.line)),
    ).map((row) => `${row.file} — ${row.why}`);
    expect(stale, "Exemption matches no write any more; delete it:").toEqual([]);
  });
});
