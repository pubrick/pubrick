import { getTableColumns, is } from "drizzle-orm";
import { getTableConfig, PgDialect, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { schema } from "./index.js";

const dialect = new PgDialect();

/** Every table declared in this package, by its Postgres name. */
// Cast to `unknown` values first: this module's exports are not all tables, and
// a type predicate has to be assignable to the type of what it narrows.
const tables = Object.values(schema as Record<string, unknown>)
  .filter((value): value is PgTable => is(value, PgTable))
  .map((table) => ({ table, config: getTableConfig(table) }));

/**
 * The columns deliberately left as open text, with who owns each value set.
 *
 * better-auth writes all three, and its organization plugin lets a deployment
 * define its own roles, so the sets are open by design and are not ours to pin.
 * They are asserted below rather than merely skipped: pinning one would be a
 * decision about another system's data, and it should fail a test rather than
 * pass review.
 */
const UNPINNED_BY_DESIGN = [
  { table: "member", column: "role" },
  { table: "invitation", column: "role" },
  { table: "invitation", column: "status" },
];

type EnumColumn = { table: string; column: string; values: readonly string[] };

/** Every column this package declares with `text(name, { enum: [...] })`. */
const enumColumns: EnumColumn[] = tables.flatMap(({ table, config }) =>
  Object.values(getTableColumns(table))
    .filter((column) => (column.enumValues?.length ?? 0) > 0)
    .map((column) => ({
      table: config.name,
      column: column.name,
      values: column.enumValues as readonly string[],
    })),
);

/** A check constraint's expression as Postgres will receive it, or null. */
function expressionOf(table: string, name: string): string | null {
  const config = tables.find((entry) => entry.config.name === table)?.config;
  const check = config?.checks.find((candidate) => candidate.name === name);
  if (!check) return null;
  return dialect.sqlToQuery(check.value).sql;
}

/** The string literals a check constraint's expression names, in sorted order. */
function literalsOf(table: string, name: string): string[] | null {
  const sql = expressionOf(table, name);
  if (sql === null) return null;
  return [...sql.matchAll(/'([^']*)'/g)].map((match) => match[1] as string).sort();
}

describe("enum columns are pinned in the database, not only in the types", () => {
  // The scanner has to find something, or every assertion below is vacuous —
  // the same failure mode db-tier.guard.test.ts exists to close one level up.
  it("finds the enum columns it exists to check", () => {
    expect(enumColumns.length).toBeGreaterThan(10);
  });

  /**
   * The ratchet. `text(col, { enum: [...] })` compiles to plain `text` in
   * Postgres, so without a check the value set lives only in the ORM's types: a
   * hand-written UPDATE, a restore of an old dump or a script can store
   * `publishd`, and every set operation in the product — `inArray(status, [...])`,
   * `status <> 'published'`, a `Record<Status, string>` written to make a new
   * status a compile error — quietly stops seeing that row.
   *
   * This is the part that closes the CLASS rather than one instance: a new enum
   * column added without a constraint fails here, naming itself.
   */
  it("gives every enum column a check constraint over exactly its own values", () => {
    const unpinned = enumColumns
      .filter((entry) => literalsOf(entry.table, `${entry.table}_${entry.column}_check`) === null)
      .map((entry) => `${entry.table}.${entry.column}`);
    expect(
      unpinned,
      'Enum column with no CHECK constraint. Add `enumCheck("<table>_<column>_check", ' +
        "t.<column>, <VALUES>)` to the table's extras and generate a migration. If the value " +
        "set genuinely belongs to a library rather than to us, the column should not carry " +
        "`{ enum: ... }` either — see UNPINNED_BY_DESIGN:",
    ).toEqual([]);
  });

  /**
   * The other half: a check that exists but has drifted from the array it was
   * written against is worse than none, because it looks enforced. Compared
   * value by value rather than by count.
   */
  it("keeps every check in step with the array it was written from", () => {
    const drifted = enumColumns
      .map((entry) => ({
        column: `${entry.table}.${entry.column}`,
        declared: [...entry.values].sort(),
        pinned: literalsOf(entry.table, `${entry.table}_${entry.column}_check`),
      }))
      .filter((entry) => JSON.stringify(entry.declared) !== JSON.stringify(entry.pinned));
    expect(drifted, "CHECK constraint out of step with its TypeScript enum:").toEqual([]);
  });

  /**
   * THE OPERATOR, not only the values.
   *
   * The two checks above read the constraint through `literalsOf`, which pulls
   * the quoted strings out of the rendered expression — so `in` flipped to
   * `not in` renders exactly the same literals in exactly the same order and
   * both of them stay green. The constraint would then say the opposite of what
   * it is for, and nothing here would notice, because `enumCheck` renders into
   * a MIGRATION: the checks already in the database were generated before the
   * edit, so no query, no insert and no db-backed suite in this repo runs
   * against the flipped expression. The first row to meet it is the first row
   * written after somebody adds an enum column and generates a migration — at
   * which point every valid value is refused, at boot, in production.
   *
   * Asserted over every check rather than one, so a new column joins the
   * ratchet by existing.
   */
  it("pins each column INTO its value set, rather than out of it", () => {
    const expressions = enumColumns.map((entry) => ({
      column: `${entry.table}.${entry.column}`,
      sql: expressionOf(entry.table, `${entry.table}_${entry.column}_check`),
    }));
    expect(expressions.length).toBeGreaterThan(10);
    for (const { column, sql } of expressions) {
      expect(sql, `${column} has no check to read`).not.toBeNull();
      expect(sql, `${column}'s check does not name its own column`).toContain(
        `"${column.split(".")[1]}"`,
      );
      expect(sql, `${column} is pinned OUT of its value set`).not.toMatch(/\bnot\s+in\s*\(/i);
      expect(sql, `${column} is not an "in (...)" check at all`).toMatch(/\bin\s*\(/i);
    }
  });

  /**
   * The complement, asserted rather than assumed. `member.role`,
   * `invitation.role` and `invitation.status` are better-auth's to write and a
   * deployment's to extend, so they are plain text on purpose — neither
   * `{ enum: ... }` in the column nor a check on the table. Pinning one would
   * refuse a role somebody's config is entitled to invent, and it would do so
   * from a migration, at boot.
   */
  it("leaves better-auth's own value sets open, on purpose", () => {
    for (const { table, column } of UNPINNED_BY_DESIGN) {
      const entry = tables.find((candidate) => candidate.config.name === table);
      const declared = Object.values(getTableColumns(entry?.table as PgTable)).find(
        (candidate) => candidate.name === column,
      );
      expect(declared, `${table}.${column} is gone`).toBeDefined();
      expect(declared?.enumValues ?? [], `${table}.${column} grew a TypeScript enum`).toEqual([]);
      expect(
        literalsOf(table, `${table}_${column}_check`),
        `${table}.${column} was pinned; better-auth defines its own roles`,
      ).toBeNull();
    }
  });
});

describe("adaptations", () => {
  const config = getTableConfig(schema.adaptations);

  /**
   * The index with the demonstrated exploit: two adaptations for one channel
   * are two publish jobs, two sends and two posts from one approval. See the
   * schema for why the predicate is `<> 'published'` and why it survives
   * increment 2c's re-adaptation.
   */
  it("admits one undelivered adaptation per item and channel", () => {
    const index = config.indexes.find(
      (candidate) => candidate.config.name === "adaptations_one_live_per_item_channel",
    );
    expect(index, "the unique index is gone").toBeDefined();
    expect(index?.config.unique).toBe(true);
    expect(index?.config.columns.map((column) => (column as { name: string }).name)).toEqual([
      "content_item_id",
      "channel_id",
    ]);
    // Written `<> 'published'` rather than as a list of deliverable statuses,
    // so a status added later is inside the constraint by default. A list would
    // silently exempt it — the failure mode that opened this hole.
    const where = index?.config.where ? dialect.sqlToQuery(index.config.where).sql : "";
    expect(where).toContain("<> 'published'");
    expect(where).not.toContain(" in (");
  });

  /** The parent key the composite foreign key below references. */
  it("declares the unique key a version row's composite reference needs", () => {
    const key = config.uniqueConstraints.find(
      (candidate) => candidate.name === "adaptations_id_content_item_id_key",
    );
    expect(key?.columns.map((column) => column.name)).toEqual(["id", "content_item_id"]);
  });
});

/**
 * The two partial unique indexes that stand between one approval and two posts
 * in somebody's channel.
 *
 * Neither was pinned anywhere. They are DDL, so nothing in this repo runs
 * against the declaration: the database the suites use was migrated from
 * `packages/db/migrations`, and an edit here — a renamed index, a different
 * column, a predicate that no longer names `in_flight` — changes what the NEXT
 * generated migration says and nothing else. The first sign would be a
 * duplicate post.
 */
describe("publications", () => {
  const config = getTableConfig(schema.publications);

  function partialUnique(name: string) {
    const index = config.indexes.find((candidate) => candidate.config.name === name);
    expect(index, `${name} is gone`).toBeDefined();
    expect(index?.config.unique, `${name} is no longer unique`).toBe(true);
    return {
      columns: index?.config.columns.map((column) => (column as { name: string }).name),
      where: index?.config.where ? dialect.sqlToQuery(index.config.where).sql : "",
    };
  }

  /**
   * The claim. It is written BEFORE the platform is called and resolved on
   * every ending the attempt survives, so a claim that outlives its attempt is
   * itself the evidence that the outcome is unknown — and the index is what
   * makes "one claim" true when pg-boss redelivers a job whose predecessor is
   * still holding it. A predicate that named any other status would leave the
   * redelivered attempt free to send a second time.
   */
  it("admits one in-flight claim per adaptation, and only for in_flight", () => {
    const { columns, where } = partialUnique("publications_one_in_flight_per_adaptation");
    expect(columns).toEqual(["adaptation_id"]);
    expect(where).toContain("= 'in_flight'");
  });

  /**
   * The bookkeeping half: two workers racing past the read-then-write guard
   * cannot leave two contradictory `published` rows behind. It is also what
   * makes `ADAPTATION_COLUMNS`' `external_url` subquery a question with one
   * answer — see the comment there.
   */
  it("admits one published receipt per adaptation, and only for published", () => {
    const { columns, where } = partialUnique("publications_one_published_per_adaptation");
    expect(columns).toEqual(["adaptation_id"]);
    expect(where).toContain("= 'published'");
  });
});

describe("content_versions", () => {
  /**
   * A version row's adaptation must belong to the version's item. MATCH SIMPLE
   * leaves master-level rows (`adaptation_id IS NULL`) unconstrained, which is
   * what makes one foreign key enough for both levels.
   */
  it("ties a version's adaptation to the version's own item", () => {
    const fk = getTableConfig(schema.contentVersions).foreignKeys.find(
      (candidate) => candidate.getName() === "content_versions_adaptation_belongs_to_item_fk",
    );
    expect(fk, "the composite foreign key is gone").toBeDefined();
    const reference = fk?.reference();
    expect(reference?.columns.map((column) => column.name)).toEqual([
      "adaptation_id",
      "content_item_id",
    ]);
    expect(reference?.foreignColumns.map((column) => column.name)).toEqual([
      "id",
      "content_item_id",
    ]);
    // Never `(org_id, adaptation_id)`: apps/api's tenancy suite plants a row
    // whose own org is this org's while the adaptation it names is a
    // stranger's, precisely to prove the repository's `org_id` predicate is
    // what refuses it. A constraint there would delete that test's premise.
    expect(reference?.columns.map((column) => column.name)).not.toContain("org_id");
  });
});
