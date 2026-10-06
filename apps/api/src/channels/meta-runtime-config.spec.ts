import { describe, expect, it } from "vitest";
import { metaRuntimeConfiguration } from "./meta-runtime-config";

const application = { clientId: "1234", clientSecret: "server-only-secret" };
describe("server-owned Meta callback origin", () => {
  it("does not require HTTPS until the optional application is configured", () => {
    expect(
      metaRuntimeConfiguration(
        "instagram_native",
        undefined,
        "http://localhost:3000",
        "http://localhost:3000",
      ),
    ).toBeUndefined();
  });
  it.each(["threads", "instagram_native", "facebook_page"] as const)(
    "pins the %s callback to the canonical public instance",
    (provider) => {
      expect(
        metaRuntimeConfiguration(
          provider,
          application,
          "https://pubrick.example",
          "https://pubrick.example",
        ),
      ).toEqual({
        provider,
        application,
        redirectUri: `https://pubrick.example/en/connections/meta/${provider}`,
      });
    },
  );
  it.each([
    ["http://pubrick.example", "http://pubrick.example"],
    ["https://pubrick.example/path", "https://pubrick.example"],
    ["https://pubrick.example?code=private", "https://pubrick.example"],
    ["https://pubrick.example#private", "https://pubrick.example"],
    ["https://user:secret@pubrick.example", "https://pubrick.example"],
    ["https://pubrick.example", "https://other.example"],
    ["https://pubrick.example", "https://pubrick.example/path"],
  ])("refuses mismatched or noncanonical configured origins", (auth, web) => {
    expect(() => metaRuntimeConfiguration("threads", application, auth, web)).toThrow(
      "canonical HTTPS",
    );
  });
});
