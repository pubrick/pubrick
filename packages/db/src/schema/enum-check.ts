import { sql } from "drizzle-orm";
import { type AnyPgColumn, check } from "drizzle-orm/pg-core";

/**
 * A CHECK constraint pinning one column to the exact members of its TypeScript
 * enum — the database half of a value set that, until now, existed only in the
 * ORM's types.
 *
 * `text("status", { enum: [...] })` is a compile-time claim and nothing else:
 * the column is plain `text` in Postgres, so a hand-written UPDATE, a psql
 * session, a restore of an old dump or a migration script can put `publishd` in
 * it and Postgres will store it. Nothing downstream reports that. Every set
 * operation in the product is written against the enum — `inArray(status,
 * ['pending','failed','scheduled'])`, `status <> 'published'` — so the bad row
 * simply never matches, and an adaptation nobody can approve, reject or publish
 * looks exactly like an adaptation nobody has got to yet. Worse where the code
 * is *exhaustive*: `PINNED_ITEM_MESSAGE` and `PINNED_ADAPTATION_MESSAGE` are
 * `Record<Status, string>` precisely so that adding a status without deciding
 * what it means is a compile error — and a row outside the enum makes that
 * lookup return `undefined` at runtime, which is the one answer the type says
 * cannot happen.
 *
 * The cost is honest and worth stating: the value set is now pinned in two
 * places, so adding a status is a migration rather than an edit to an array.
 * That is the point. Every status this product has is load-bearing in a
 * transition table somewhere, and a status that ships without a migration is a
 * status that shipped without anyone reading the transitions — `RUN_STATUSES`
 * already says so in prose ("when it arrives it arrives here"), and this makes
 * the prose enforceable. `schema-enum-check.test.ts` is the other half: it
 * fails when an enum column has no check, so the pair cannot drift.
 *
 * "TWO PLACES" IS THE COLUMN AND THE MIGRATION, NOT TWO COPIES OF THE LIST.
 * The lists themselves are declared once, in `@pubrick/shared`, and this
 * package imports them: the web has no database dependency and must not grow
 * one, so a status list restated here is a status list the browser keeps a
 * hand-written copy of. What the constraint adds is the SQL half — a value set
 * the database enforces rather than one the ORM merely claims.
 *
 * The literals are interpolated with `sql.raw` rather than bound as parameters
 * because this expression is DDL — drizzle-kit renders it into a migration
 * file, where a `$1` placeholder has nothing to bind to. Safe by construction
 * and not by trust: every value comes from a `readonly [...]` of string
 * literals declared in this package or in `@pubrick/shared` — never from input
 * — and `assertQuotable` refuses anything that could close the quote it is
 * being placed inside.
 */
export function enumCheck(name: string, column: AnyPgColumn, values: readonly string[]) {
  const list = values.map(assertQuotable).join(", ");
  return check(name, sql`${column} in (${sql.raw(list)})`);
}

/**
 * Refuses a value that cannot be safely single-quoted into DDL. A guard on the
 * one line in this package that builds SQL by concatenation: today every caller
 * passes a compile-time literal, and the day one does not, this throws while
 * generating a migration rather than emitting one.
 */
function assertQuotable(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) {
    throw new Error(`enumCheck: ${JSON.stringify(value)} is not a plain lower_snake identifier`);
  }
  return `'${value}'`;
}
