import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
 * WHY A GREP AND NOT A TYPE. drizzle's `.set()` takes a Partial, so there is no
 * compiler seat for "this field is required when that one is present", and the
 * only alternative — funnelling every write through one helper — is a bigger
 * change than the invariant is worth and would still admit a caller that went
 * round it. A scan of the real source is what the repo already does for the
 * env-declaration and db-tier guards, with their rule: a scanner that silently
 * drops what it cannot classify reads exactly like "nothing to report", so this
 * one asserts it found something before it asserts anything about what it found.
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
 * Every `.update(schema.adaptations)` whose `.set({ ... })` names `status`.
 *
 * The chain is matched from `.update(schema.adaptations)` to the end of its
 * `.set({ ... })` object, counting braces, so a `.set()` spread over twenty
 * formatted lines — which every writer in this repo is — is read whole rather
 * than as its first line. An insert is deliberately not matched: a row born
 * `pending` has no verdict to carry, and the column's default is the null that
 * says so.
 */
function adaptationStatusWrites(): Write[] {
  const writes: Write[] = [];
  for (const root of ROOTS) {
    for (const file of sourceFiles(path.join(repoRoot, root))) {
      const text = readFileSync(file, "utf8");
      const marker = /\.update\(\s*schema\.adaptations\s*\)/g;
      for (const match of text.matchAll(marker)) {
        const setAt = text.indexOf(".set({", match.index);
        if (setAt === -1) continue;
        // Nothing but whitespace and chained calls may sit between the two, or
        // this `.set` belongs to a different statement further down the file.
        if (/\.update\(/.test(text.slice(match.index + match[0].length, setAt))) continue;
        let depth = 0;
        let end = setAt + ".set(".length;
        for (; end < text.length; end += 1) {
          const char = text[end];
          if (char === "{" || char === "(") depth += 1;
          else if (char === "}" || char === ")") {
            depth -= 1;
            if (depth === 0) break;
          }
        }
        const body = text.slice(setAt, end + 1);
        if (!/\bstatus\s*:/.test(body)) continue;
        writes.push({
          file: path.relative(repoRoot, file),
          line: text.slice(0, setAt).split("\n").length,
          text: body,
          // `failureReason: null` and the shorthand `failureReason,` both
          // count; a mention inside a comment does not, which is why the name
          // has to be followed by the punctuation an object property carries.
          hasFailureReason: /\bfailureReason\s*[:,}]/.test(body),
        });
      }
    }
  }
  return writes;
}

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
    // Four in the api (approve, reject, the delivery resolver) and five in the
    // worker (markPublishing, markPublished, markAlreadyPublished, markFailed,
    // sweepAbandoned). A bare "greater than zero" would survive the scan finding
    // one of them.
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
