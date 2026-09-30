import { expect, it, vi } from "vitest";
import { api } from "./api";
import { billing, billingDestination, billingPrice } from "./billing";

vi.mock("./api", () => ({ api: vi.fn() }));
it.each([
  "javascript:alert(1)",
  "data:text/html,hello",
  "http://evil.example",
  "https://user:pass@billing.example",
])("refuses unsafe session destination %s", (url) => {
  expect(() => billingDestination(url, true)).toThrow();
});
it("accepts HTTPS and explicit test loopback, refusing loopback HTTP outside test mode", () => {
  expect(billingDestination("https://checkout.example/session", false)).toBe(
    "https://checkout.example/session",
  );
  expect(billingDestination("http://127.0.0.1:31000/fixture", true)).toContain("127.0.0.1");
  expect(() => billingDestination("http://127.0.0.1:31000/fixture", false)).toThrow();
});
it("checkout sends catalog plan and locale, never browser-provided prices or limits", async () => {
  await billing.checkout("plan-basic", "ru");
  expect(api).toHaveBeenCalledWith("/api/billing/checkout", {
    method: "POST",
    body: JSON.stringify({ planId: "plan-basic", locale: "ru" }),
  });
});

it("respects vendor minor units for zero and three decimal currencies", () => {
  const plan = {
    id: "test",
    version: 1,
    limits: { seats: 1, brands: 1, channels: 1, mediaBytes: 0, concurrentJobs: 1 },
    currency: "JPY",
    unitAmount: 2000,
    interval: "month" as const,
    intervalCount: 1,
  };
  expect(billingPrice(plan, "en")).toContain("2,000");
  expect(billingPrice({ ...plan, currency: "BHD" }, "en")).toContain("2.000");
});
