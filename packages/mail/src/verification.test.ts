import { SignJWT } from "jose";
import { expect, it } from "vitest";
import { verificationMailDeadline } from "./verification.js";

it("authenticates Better Auth verification expiry and rejects updateTo and wrong owners", async () => {
  const secret = "synthetic-auth-secret";
  const exp = Math.floor(Date.now() / 1000) + 3600;
  async function link(extra: Record<string, unknown> = {}) {
    const token = await new SignJWT({ email: "person@example.com", ...extra })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime(exp)
      .sign(new TextEncoder().encode(secret));
    return `https://pubrick.example/api/auth/verify-email?token=${token}`;
  }
  expect(await verificationMailDeadline(await link(), secret, "person@example.com")).toBe(
    exp * 1000,
  );
  await expect(
    verificationMailDeadline(
      await link({ updateTo: "other@example.com" }),
      secret,
      "person@example.com",
    ),
  ).rejects.toMatchObject({ code: "invalid_payload" });
  await expect(
    verificationMailDeadline(await link(), "different-secret", "person@example.com"),
  ).rejects.toMatchObject({ code: "invalid_payload" });
  await expect(
    verificationMailDeadline(await link(), secret, "other@example.com"),
  ).rejects.toMatchObject({ code: "invalid_payload" });
});
