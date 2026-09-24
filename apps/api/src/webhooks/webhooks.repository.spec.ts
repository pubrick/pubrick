import { beforeAll, describe, expect, it } from "vitest";

let validateWebhookUrl: typeof import("./webhooks.repository").validateWebhookUrl;

beforeAll(async () => {
  process.env.DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:5432/unused";
  process.env.BETTER_AUTH_SECRET ??= "webhook-test-secret";
  process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
  ({ validateWebhookUrl } = await import("./webhooks.repository"));
});

describe("webhook endpoint validation", () => {
  it("accepts a public-shaped HTTPS hostname and path", () => {
    expect(validateWebhookUrl("https://hooks.example.com/receive")).toBe(
      "https://hooks.example.com/receive",
    );
  });

  it.each([
    "http://hooks.example.com/receive",
    "https://localhost/receive",
    "https://127.0.0.1/receive",
    "https://[::1]/receive",
    "https://user:pass@hooks.example.com/receive",
    "https://hooks.example.com:8443/receive",
    "https://hooks.example.com/receive?token=x",
    "https://hooks.example.com/receive#frag",
    "file:///etc/passwd",
  ])("rejects unsafe destination %s", (url) => {
    expect(() => validateWebhookUrl(url)).toThrow();
  });
});
