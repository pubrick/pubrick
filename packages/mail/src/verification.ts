import { jwtVerify } from "jose";
import { AuthMailError } from "./payload.js";
/** Exact Better Auth 1.7 signed email verification format. Change-email is disabled. */
export async function verificationMailDeadline(
  link: string,
  secret: string,
  recipient: string,
): Promise<number> {
  try {
    const token = new URL(link).searchParams.get("token");
    if (!token) throw new Error();
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      algorithms: ["HS256"],
    });
    if (
      payload.updateTo !== undefined ||
      typeof payload.email !== "string" ||
      payload.email.toLowerCase() !== recipient.toLowerCase() ||
      typeof payload.exp !== "number" ||
      !Number.isSafeInteger(payload.exp)
    )
      throw new Error();
    return payload.exp * 1000;
  } catch {
    throw new AuthMailError("invalid_payload");
  }
}
