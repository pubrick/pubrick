import { createHash } from "node:crypto";
import { decryptJson, encryptJson } from "@pubrick/shared";
import { z } from "zod";

export type AuthMailErrorCode =
  | "configuration"
  | "invalid_payload"
  | "unreadable_payload"
  | "authentication"
  | "rejected"
  | "transient"
  | "timeout"
  | "unavailable";
/** Provider responses, addresses, signed links and error causes never escape. */
export class AuthMailError extends Error {
  constructor(public readonly code: AuthMailErrorCode) {
    super(code);
    this.name = "AuthMailError";
  }
}
export const AUTH_MAIL_MAX_AGE_SECONDS = { verify: 3600, reset: 3600, invite: 48 * 3600 } as const;
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const identitySchema = z
  .object({
    origin: z.string().max(2048),
    deploymentMode: z.enum(["self-hosted", "hosted"]),
    authSecretId: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type MailIdentity = z.infer<typeof identitySchema>;
function origin(value: string): string {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !["https:", "http:"].includes(url.protocol) ||
    (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
    throw new Error("origin");
  return url.origin;
}
export function createMailIdentity(
  publicOrigin: string,
  deploymentMode: MailIdentity["deploymentMode"],
  authSecret: string,
): MailIdentity {
  try {
    if (!authSecret.trim()) throw new Error("secret");
    return identitySchema.parse({
      origin: origin(publicOrigin),
      deploymentMode,
      authSecretId: createHash("sha256")
        .update("pubrick-auth-mail-v1\0")
        .update(authSecret)
        .digest("hex"),
    });
  } catch {
    throw new AuthMailError("configuration");
  }
}
const common = {
  purpose: z.literal("pubrick-auth-mail"),
  version: z.literal(1),
  jobId: z.uuid(),
  identity: identitySchema,
  recipient: z.email().max(512),
  locale: z.enum(["en", "es", "ru", "pt"]),
  createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  messageId: z
    .string()
    .regex(/^<pubrick-auth\.[A-Za-z0-9_-]+@[A-Za-z0-9.-]+>$/)
    .max(512),
  link: z.string().max(8192),
};
const payloadSchema = z.discriminatedUnion("kind", [
  z.object({ ...common, kind: z.literal("verify"), userId: identifier }).strict(),
  z.object({ ...common, kind: z.literal("reset"), userId: identifier }).strict(),
  z
    .object({
      ...common,
      kind: z.literal("invite"),
      invitationId: identifier,
      organizationId: identifier,
      userId: z.undefined().optional(),
    })
    .strict(),
]);
export type AuthMailPayload = z.infer<typeof payloadSchema>;
export type EncryptedAuthMail = Readonly<{ ciphertext: string }>;
function resetToken(url: URL): string {
  const token = decodeURIComponent(url.pathname.slice("/api/auth/reset-password/".length));
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(token)) throw new Error("reset token");
  return token;
}
export function resetMailVerificationIdentifier(value: unknown): string {
  const payload = validateAuthMail(value);
  if (payload.kind !== "reset") throw new AuthMailError("invalid_payload");
  return `reset-password:${resetToken(new URL(payload.link))}`;
}
export function validateAuthMail(value: unknown): AuthMailPayload {
  try {
    const data = payloadSchema.parse(value);
    if (
      origin(data.identity.origin) !== data.identity.origin ||
      data.expiresAt <= data.createdAt ||
      data.expiresAt - data.createdAt > AUTH_MAIL_MAX_AGE_SECONDS[data.kind] * 1000 ||
      !data.messageId.startsWith(`<pubrick-auth.${data.jobId}@`)
    )
      throw new Error("deadline");
    const url = new URL(data.link);
    if (url.origin !== data.identity.origin || url.username || url.password || url.hash)
      throw new Error("link");
    if (data.kind === "invite") {
      if (
        url.pathname !== `/${data.locale}/onboarding` ||
        url.searchParams.get("invitation") !== data.invitationId
      )
        throw new Error("invite");
    } else {
      if (
        data.kind === "verify"
          ? url.pathname !== "/api/auth/verify-email" || !url.searchParams.get("token")
          : !/^\/api\/auth\/reset-password\/[^/]+$/.test(url.pathname)
      )
        throw new Error("link kind");
      if (data.kind === "reset") resetToken(url);
      const callback = url.searchParams.get("callbackURL");
      if (callback && callback !== "/") {
        const target = new URL(callback, data.identity.origin);
        if (
          callback.startsWith("//") ||
          callback.startsWith("/\\") ||
          target.origin !== data.identity.origin ||
          target.username ||
          target.password ||
          target.hash ||
          !/^\/(en|es|ru|pt)\/(verify-email|reset-password|login|onboarding)$/.test(target.pathname)
        )
          throw new Error("callback");
      }
    }
    return data;
  } catch {
    throw new AuthMailError("invalid_payload");
  }
}
export function sealAuthMail(value: unknown, keyRing: string): EncryptedAuthMail {
  const payload = validateAuthMail(value);
  try {
    return { ciphertext: encryptJson(payload, keyRing) };
  } catch {
    throw new AuthMailError("configuration");
  }
}
export function openAuthMail(value: unknown, keyRing: string): AuthMailPayload {
  let decoded: unknown;
  try {
    const envelope = z
      .object({ ciphertext: z.string().min(1).max(65536) })
      .strict()
      .parse(value);
    decoded = decryptJson(envelope.ciphertext, keyRing);
  } catch {
    throw new AuthMailError("unreadable_payload");
  }
  return validateAuthMail(decoded);
}
export type UserMailSnapshot = Readonly<{ id: string; email: string; emailVerified: boolean }>;
export type InvitationMailSnapshot = Readonly<{
  id: string;
  organizationId: string;
  email: string;
  status: string;
  expiresAt: number;
  organizationExists: boolean;
}>;
export type ResetVerificationSnapshot = Readonly<{
  identifier: string;
  userId: string;
  expiresAt: number;
}>;
export type MailOwnershipSnapshot = Readonly<{
  user?: UserMailSnapshot | null;
  resetVerification?: ResetVerificationSnapshot | null;
  invitation?: InvitationMailSnapshot | null;
}>;
export type DeliveryEligibility =
  | "eligible"
  | "invalid_payload"
  | "expired"
  | "identity_mismatch"
  | "missing_target"
  | "recipient_changed"
  | "already_verified"
  | "invitation_closed"
  | "reset_token_invalid";
export function deliveryEligibility(
  value: unknown,
  currentIdentity: MailIdentity,
  now: number,
  snapshot: MailOwnershipSnapshot,
): DeliveryEligibility {
  let data: AuthMailPayload;
  try {
    data = validateAuthMail(value);
  } catch {
    return "invalid_payload";
  }
  if (!Number.isSafeInteger(now) || data.createdAt > now + 60_000) return "invalid_payload";
  if (
    data.identity.origin !== currentIdentity.origin ||
    data.identity.deploymentMode !== currentIdentity.deploymentMode ||
    data.identity.authSecretId !== currentIdentity.authSecretId
  )
    return "identity_mismatch";
  if (data.expiresAt <= now) return "expired";
  if (data.kind === "invite") {
    const invitation = snapshot.invitation;
    if (
      !invitation ||
      invitation.id !== data.invitationId ||
      invitation.organizationId !== data.organizationId ||
      !invitation.organizationExists
    )
      return "missing_target";
    if (invitation.email.toLowerCase() !== data.recipient.toLowerCase()) return "recipient_changed";
    if (!Number.isSafeInteger(invitation.expiresAt) || invitation.expiresAt <= now)
      return "expired";
    if (invitation.status !== "pending") return "invitation_closed";
  } else {
    const user = snapshot.user;
    if (!user || user.id !== data.userId) return "missing_target";
    if (user.email.toLowerCase() !== data.recipient.toLowerCase()) return "recipient_changed";
    if (data.kind === "verify" && user.emailVerified) return "already_verified";
    if (data.kind === "reset") {
      const verification = snapshot.resetVerification;
      if (
        !verification ||
        verification.identifier !== resetMailVerificationIdentifier(data) ||
        verification.userId !== data.userId
      )
        return "reset_token_invalid";
      if (!Number.isSafeInteger(verification.expiresAt) || verification.expiresAt <= now)
        return "expired";
    }
  }
  return "eligible";
}
