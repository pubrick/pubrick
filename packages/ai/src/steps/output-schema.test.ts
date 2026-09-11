import { MAX_BODY_LENGTH } from "@pubrick/shared";
import { Output } from "ai";
import { describe, expect, it } from "vitest";
import { adaptationLimit, adapterFor } from "./adapter.js";
import { EDITOR } from "./editor.js";
import { WRITER } from "./writer.js";

/**
 * The step schemas normalise newlines BEFORE the length bound (a CRLF reply
 * that fits once collapsed must pass) — and they must do it in a way that
 * keeps the bound in the JSON Schema the provider is sent. A
 * `transform().pipe()` normalises correctly and silently erases `minLength`
 * and `maxLength` from that schema (measured on `Output.object(...)`), so the
 * model is held to a limit it was never told. `z.string().overwrite()` keeps
 * both. This file pins both halves for the three body-bearing steps.
 */
async function providerSchema(schema: unknown): Promise<Record<string, unknown>> {
  const output = Output.object({ schema: schema as never });
  const rf = (output as { responseFormat: unknown }).responseFormat;
  const resolved = (typeof rf === "function" ? await rf() : await rf) as {
    schema: { properties: { body: Record<string, unknown> } };
  };
  return resolved.schema.properties.body;
}

const channel = {
  id: "3f1f0a1c-0d5b-4f5c-9b7e-2c4a6d8e0f11",
  name: "Cafe Notes",
  platform: "bluesky" as const,
};

describe("the provider is told the bound the reply is held to", () => {
  it.each([
    ["writer", WRITER.schema, MAX_BODY_LENGTH],
    ["editor", EDITOR.schema, MAX_BODY_LENGTH],
  ] as const)("%s: minLength 1 and maxLength on `body`", async (_name, schema, max) => {
    const body = await providerSchema(schema);
    expect(body.type).toBe("string");
    expect(body.minLength).toBe(1);
    expect(body.maxLength).toBe(max);
  });

  it("adapter: maxLength is the platform's own limit", async () => {
    const body = await providerSchema(adapterFor(channel).schema);
    expect(body.maxLength).toBe(adaptationLimit(channel.platform));
    expect(body.minLength).toBe(1);
  });
});

describe("newlines are canonical before the bound is measured", () => {
  it("writer: a CRLF reply that fits once collapsed is accepted, and stored LF-only", () => {
    const half = Math.floor(MAX_BODY_LENGTH / 2);
    const crlf = Array(half).fill("x").join("\r\n"); // > MAX as typed, < MAX collapsed
    expect(crlf.length).toBeGreaterThan(MAX_BODY_LENGTH);
    const parsed = WRITER.schema.parse({ body: crlf });
    expect(parsed.body).not.toContain("\r");
    expect(parsed.body.length).toBeLessThanOrEqual(MAX_BODY_LENGTH);
  });

  it("editor: one character past the bound after collapsing is refused on `body`", () => {
    const result = EDITOR.schema.safeParse({ body: "x".repeat(MAX_BODY_LENGTH + 1) });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["body"]);
  });
});
