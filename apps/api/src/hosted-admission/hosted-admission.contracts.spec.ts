import { expect, it } from "vitest";
import { hostedInviteInputSchema } from "./hosted-admission.contracts";

it("uses maintained email validation before repository writes", () => {
  for (const email of ["@", "a@", "a@b", "a@@example.com", "a\n@example.com"]) {
    expect(hostedInviteInputSchema.safeParse({ email, role: "member", locale: "en" }).success).toBe(
      false,
    );
  }
  expect(
    hostedInviteInputSchema.parse({ email: " Alice@Example.com ", role: "member", locale: "ru" })
      .email,
  ).toBe("alice@example.com");
  expect(
    hostedInviteInputSchema.safeParse({
      email: "a@example.com",
      role: "member",
      locale: "en",
      userId: "forged",
    }).success,
  ).toBe(false);
});
