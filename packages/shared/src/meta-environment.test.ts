import { describe, expect, it } from "vitest";
import { metaApplicationConfigurations, metaEnvironmentSchema } from "./meta-environment.js";

describe("optional, distinct Meta server applications", () => {
  it("keeps existing instances working with all applications unset", () => {
    const values = metaEnvironmentSchema.parse({
      THREADS_CLIENT_ID: "",
      THREADS_CLIENT_SECRET: "",
      META_GRAPH_API_VERSION: "",
    });
    expect(values.META_GRAPH_API_VERSION).toBe("v26.0");
    expect(metaApplicationConfigurations(values)).toEqual({
      threads: undefined,
      instagram_native: undefined,
      facebook_page: undefined,
    });
  });
  it.each(["THREADS", "INSTAGRAM", "FACEBOOK"])(
    "rejects either incomplete %s application",
    (prefix) => {
      for (const value of [
        { [`${prefix}_CLIENT_ID`]: "1234" },
        { [`${prefix}_CLIENT_SECRET`]: "server-only-secret" },
      ])
        expect(() => metaApplicationConfigurations(metaEnvironmentSchema.parse(value))).toThrow(
          "Set both",
        );
    },
  );
  it("does not reuse Facebook credentials for Instagram or Threads", () => {
    expect(
      metaApplicationConfigurations(
        metaEnvironmentSchema.parse({
          THREADS_CLIENT_ID: "101",
          THREADS_CLIENT_SECRET: "threads-secret",
          INSTAGRAM_CLIENT_ID: "202",
          INSTAGRAM_CLIENT_SECRET: "instagram-secret",
          FACEBOOK_CLIENT_ID: "303",
          FACEBOOK_CLIENT_SECRET: "facebook-secret",
        }),
      ),
    ).toEqual({
      threads: { clientId: "101", clientSecret: "threads-secret" },
      instagram_native: { clientId: "202", clientSecret: "instagram-secret" },
      facebook_page: { clientId: "303", clientSecret: "facebook-secret" },
    });
  });
  it.each([
    { THREADS_CLIENT_ID: "https://other.example" },
    { INSTAGRAM_CLIENT_ID: "0" },
    { FACEBOOK_CLIENT_SECRET: "secret\nheader" },
    { THREADS_CLIENT_SECRET: " " },
    { META_GRAPH_API_VERSION: "https://other.example/v26.0" },
    { META_GRAPH_API_VERSION: "v26.0/../oauth" },
    { META_GRAPH_API_VERSION: "v27.0" },
  ])("rejects malformed server configuration", (values) => {
    expect(metaEnvironmentSchema.safeParse(values).success).toBe(false);
  });
});
