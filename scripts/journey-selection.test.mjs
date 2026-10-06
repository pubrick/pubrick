import assert from "node:assert/strict";
import { test } from "node:test";
import { journeySelection } from "./e2e/journey-selection.mjs";

test("default acceptance runs the full journey list", () => {
  assert.equal(journeySelection([]), undefined);
});
test("a focused rerun retains the real worker publication proof", () => {
  const pattern = new RegExp(journeySelection(["--grep", "responsibility"]));
  assert.ok(pattern.test("responsibility preserves composer edits and mobile guest review"));
  assert.ok(
    pattern.test(
      "account, manual approval, verified channel, worker publication and UI tenant switching",
    ),
  );
  assert.equal(pattern.test("unrelated unchanged journey"), false);
});
test("invalid selection cannot allocate a stack or supply an external target", () => {
  for (const args of [
    ["--target-url", "https://other.example"],
    ["scripts/e2e/other.spec.ts"],
    ["--grep", ""],
    ["--grep", "x".repeat(201)],
    ["--grep", "["],
  ])
    assert.throws(() => journeySelection(args));
});
