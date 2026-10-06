import { z } from "zod";

const token = z
  .string()
  .min(1)
  .max(8192)
  .regex(/^[\x21-\x7e]+$/);
export const metaAccountIdSchema = z.string().regex(/^[1-9]\d{0,30}$/);
const lifecycle = {
  // These fields are encrypted OAuth metadata, never proof of a current grant.
  refreshToken: token.optional(),
  scopes: z.string().max(2048).optional(),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
};
export const threadsCredentialsSchema = z.strictObject({
  accessToken: token,
  accountId: metaAccountIdSchema,
  ...lifecycle,
});
export type ThreadsCredentials = z.infer<typeof threadsCredentialsSchema>;
export const instagramNativeCredentialsSchema = z.strictObject({
  accessToken: token,
  accountId: metaAccountIdSchema,
  ...lifecycle,
});
export type InstagramNativeCredentials = z.infer<typeof instagramNativeCredentialsSchema>;
export const facebookPageCredentialsSchema = z.strictObject({
  accessToken: token,
  /** Retained User token proves the selected Page's current CREATE_CONTENT task. */
  userAccessToken: token,
  pageId: metaAccountIdSchema,
  ...lifecycle,
});
export type FacebookPageCredentials = z.infer<typeof facebookPageCredentialsSchema>;

export function threadsCredentialTarget(credentials: ThreadsCredentials): string {
  return `threads:${threadsCredentialsSchema.parse(credentials).accountId}`;
}
export function instagramCredentialTarget(credentials: InstagramNativeCredentials): string {
  return `instagram:${instagramNativeCredentialsSchema.parse(credentials).accountId}`;
}
export function facebookPageCredentialTarget(credentials: FacebookPageCredentials): string {
  return `facebook-page:${facebookPageCredentialsSchema.parse(credentials).pageId}`;
}
