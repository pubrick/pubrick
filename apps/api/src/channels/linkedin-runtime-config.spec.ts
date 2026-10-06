import { describe, expect, it } from "vitest";
import { linkedinRuntimeConfiguration } from "./linkedin-runtime-config";

const application = { clientId: "fixture-client", clientSecret: "fixture-secret" };
describe("fixed LinkedIn public callback", () => {
  it("does not require HTTPS for an operator who leaves LinkedIn disabled", () => {
    expect(
      linkedinRuntimeConfiguration(undefined, "http://localhost:3000", "http://localhost:3000"),
    ).toBeUndefined();
  });
  it("derives one registered callback from the canonical origin", () => {
    expect(
      linkedinRuntimeConfiguration(
        application,
        "https://pubrick.example.com",
        "https://pubrick.example.com",
      ),
    ).toEqual({ application, redirectUri: "https://pubrick.example.com/en/connections/linkedin" });
  });
  it.each([
    ["http://localhost:3000", "http://localhost:3000"],
    ["https://pubrick.example.com/path", "https://pubrick.example.com"],
    ["https://pubrick.example.com?tenant=1", "https://pubrick.example.com"],
    ["https://pubrick.example.com#other", "https://pubrick.example.com"],
    ["https://user:secret@pubrick.example.com", "https://pubrick.example.com"],
    ["https://pubrick.example.com", "https://other.example.com"],
    ["https://pubrick.example.com", "https://pubrick.example.com/other"],
    ["https://pubrick.example.com", "https://pubrick.example.com?other=1"],
  ])("refuses noncanonical origins %s / %s", (auth, web) => {
    expect(() => linkedinRuntimeConfiguration(application, auth, web)).toThrow();
  });
});
