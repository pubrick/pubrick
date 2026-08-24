import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseEnv } from "./env.js";

describe("parseEnv", () => {
  it("returns typed values for valid input", () => {
    const env = parseEnv(
      { DATABASE_URL: z.string().url(), PORT: z.coerce.number().default(3001) },
      { DATABASE_URL: "postgres://localhost:5432/x" },
    );
    expect(env.DATABASE_URL).toBe("postgres://localhost:5432/x");
    expect(env.PORT).toBe(3001);
  });

  it("throws listing every invalid variable", () => {
    expect(() =>
      parseEnv({ DATABASE_URL: z.string().url(), API_KEY: z.string().min(1) }, {}),
    ).toThrowError(/DATABASE_URL[\s\S]*API_KEY/);
  });
});
