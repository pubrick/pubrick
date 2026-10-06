import { z } from "zod";
import { decryptJson, encryptJson } from "./crypto.js";
import { approvedJpegIdentitySchema, metaPublicationIdentitySchema } from "./meta-publication.js";

export const META_MEDIA_ACCESS_TTL_MS = 5 * 60_000;
export const metaMediaAccessSchema = z
  .strictObject({
    purpose: z.literal("meta_preparation"),
    stageId: z.uuid(),
    identity: metaPublicationIdentitySchema,
    image: approvedJpegIdentitySchema,
    issuedAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .refine(({ issuedAt, expiresAt }) => {
    const duration = Date.parse(expiresAt) - Date.parse(issuedAt);
    return duration > 0 && duration <= META_MEDIA_ACCESS_TTL_MS;
  });
export type MetaMediaAccess = z.infer<typeof metaMediaAccessSchema>;

/** Encrypted purpose-bound bearer, issued only by the worker for reviewed image bytes. */
export function sealMetaMediaAccess(value: MetaMediaAccess, key: string): string {
  const payload = metaMediaAccessSchema.parse(value);
  return Buffer.from(encryptJson(payload, key), "utf8").toString("base64url");
}

/** No untrusted object is returned before tenant, purpose, lifetime and authentication checks. */
export function openMetaMediaAccess(
  orgId: string,
  value: string,
  key: string,
  now = Date.now(),
): MetaMediaAccess {
  try {
    if (!/^[A-Za-z0-9_-]{1,6000}$/.test(value)) throw new Error();
    const envelope = Buffer.from(value, "base64url");
    if (envelope.toString("base64url") !== value) throw new Error();
    const payload = metaMediaAccessSchema.parse(decryptJson(envelope.toString("utf8"), key));
    if (
      payload.identity.orgId !== orgId ||
      Date.parse(payload.issuedAt) > now ||
      Date.parse(payload.expiresAt) <= now
    )
      throw new Error();
    return payload;
  } catch {
    // Never attach encrypted payloads, URLs, decrypted claims or crypto causes to an error.
    throw new Error("Approved image access is unavailable");
  }
}
