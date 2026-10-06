import { describe, expect, it } from "vitest";
import {
  linkedinApplicationConfiguration,
  linkedinEnvironmentSchema,
} from "./linkedin-environment.js";

describe("optional LinkedIn server application", () => {
  it("keeps existing servers without a configured application working", () => {
    expect(linkedinApplicationConfiguration(linkedinEnvironmentSchema.parse({}))).toBeUndefined();
    expect(
      linkedinApplicationConfiguration(
        linkedinEnvironmentSchema.parse({ LINKEDIN_CLIENT_ID: "", LINKEDIN_CLIENT_SECRET: "" }),
      ),
    ).toBeUndefined();
  });
  it.each([{ LINKEDIN_CLIENT_ID: "client" }, { LINKEDIN_CLIENT_SECRET: "secret" }])(
    "refuses a half-configured application",
    (value) => {
      expect(() =>
        linkedinApplicationConfiguration(linkedinEnvironmentSchema.parse(value)),
      ).toThrow("Set both");
    },
  );
  it.each([
    { LINKEDIN_CLIENT_ID: "client", LINKEDIN_CLIENT_SECRET: "   " },
    { LINKEDIN_CLIENT_ID: "client id", LINKEDIN_CLIENT_SECRET: "secret" },
    { LINKEDIN_CLIENT_ID: "client", LINKEDIN_CLIENT_SECRET: "a".repeat(8193) },
  ])("rejects unusable application credentials", (value) => {
    expect(linkedinEnvironmentSchema.safeParse(value).success).toBe(false);
  });
  it("keeps the confidential application on the server", () => {
    const value = { LINKEDIN_CLIENT_ID: "client", LINKEDIN_CLIENT_SECRET: "secret" };
    expect(linkedinApplicationConfiguration(linkedinEnvironmentSchema.parse(value))).toEqual({
      clientId: "client",
      clientSecret: "secret",
    });
  });
});
