import type { CostSource } from "@pubrick/ai";
import { AI_PROVIDERS as AI_PACKAGE_PROVIDERS } from "@pubrick/ai";
import { schema } from "@pubrick/db";
import { AI_COST_SOURCES, AI_PROVIDERS } from "@pubrick/shared";
import { describe, expect, it } from "vitest";

// One list of model providers, kept by hand in three packages that cannot all
// import each other: `@pubrick/db` owns the column enum, `@pubrick/ai` owns the
// factory that builds a model, and `@pubrick/shared` owns the zod enum the API
// validates request bodies and path parameters against. Drift means either a
// provider the API accepts and the column rejects (a 500 on save), or one the
// column allows and no factory can build (a 500 on the first call).
//
// Same shape as `platforms.spec.ts`: a type-level assertion so the gate fails on
// typecheck, and a value-level one so it fails on test too.

type DbProvider = (typeof schema.AI_PROVIDERS)[number];
type SharedProvider = (typeof AI_PROVIDERS)[number];
type AiPackageProvider = (typeof AI_PACKAGE_PROVIDERS)[number];
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe("AI provider enums", () => {
  it("db, shared and the ai package list the same providers, in the same order", () => {
    // Typecheck gate: these stop compiling the moment any pair diverges.
    const dbMatchesShared: Equal<DbProvider, SharedProvider> = true;
    const aiMatchesShared: Equal<AiPackageProvider, SharedProvider> = true;
    expect(dbMatchesShared).toBe(true);
    expect(aiMatchesShared).toBe(true);

    expect([...schema.AI_PROVIDERS]).toEqual([...AI_PROVIDERS]);
    expect([...AI_PACKAGE_PROVIDERS]).toEqual([...AI_PROVIDERS]);
  });
});

// `cost_source` is the same problem one column over: `@pubrick/db` owns the
// enum, `@pubrick/ai` decides which member each call gets, and `@pubrick/shared`
// types the three display rules against it. A member added to one and not the
// others is a row the rules cannot classify — and the rules are what stop a
// nullable SUM() from printing a confident wrong number.

type DbCostSource = (typeof schema.COST_SOURCES)[number];
type SharedCostSource = (typeof AI_COST_SOURCES)[number];

describe("cost source enums", () => {
  it("db, shared and the ai package agree on where a cost figure can come from", () => {
    const dbMatchesShared: Equal<DbCostSource, SharedCostSource> = true;
    const aiMatchesShared: Equal<CostSource, SharedCostSource> = true;
    expect(dbMatchesShared).toBe(true);
    expect(aiMatchesShared).toBe(true);

    expect([...schema.COST_SOURCES]).toEqual([...AI_COST_SOURCES]);
  });
});
