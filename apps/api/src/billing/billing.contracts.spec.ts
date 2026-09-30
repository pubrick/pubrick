import { expect, it } from "vitest";
import { checkoutInputSchema, localeInputSchema, webhookInput } from "./billing.contracts";

it("accepts only internal plan and supported locale, never caller price or return URL", () => {
  expect(checkoutInputSchema.parse({ planId: "team", locale: "ru" })).toEqual({
    planId: "team",
    locale: "ru",
  });
  for (const input of [
    { planId: "team", locale: "ru", priceId: "price_unowned" },
    { planId: "team", locale: "ru", returnUrl: "https://evil.test" },
    { planId: "team", locale: "de" },
  ])
    expect(() => checkoutInputSchema.parse(input)).toThrow();
  expect(() => localeInputSchema.parse({ locale: "en", customerId: "cus_other" })).toThrow();
});
it("requires bounded exact raw bytes and a single signature header", () => {
  const bytes = Buffer.from('{"spaces":  true}\n');
  expect(
    webhookInput({ rawBody: bytes, headers: { "stripe-signature": "t=1,v1=abc" } }).bytes,
  ).toBe(bytes);
  for (const request of [
    { body: { x: 1 }, headers: { "stripe-signature": "signature" } },
    { rawBody: Buffer.alloc(1024 * 1024 + 1), headers: { "stripe-signature": "signature" } },
    { rawBody: bytes, headers: { "stripe-signature": ["one", "two"] } },
  ])
    expect(() => webhookInput(request)).toThrow();
});
