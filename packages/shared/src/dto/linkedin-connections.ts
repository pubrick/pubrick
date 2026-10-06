import { z } from "zod";

export const LINKEDIN_AUTHORIZATION_TTL_SECONDS = 10 * 60;
export const LINKEDIN_MAX_AUTHORIZATION_REQUESTS = 50;
export const LINKEDIN_AUTHORIZATION_LOCALES = ["en", "es", "ru", "pt"] as const;
export const linkedinAuthorizationStartSchema = z
  .strictObject({
    brandId: z.uuid(),
    name: z.string().trim().min(1).max(200),
    locale: z.enum(LINKEDIN_AUTHORIZATION_LOCALES),
    channelId: z.uuid().optional(),
    expectedGeneration: z.number().int().nonnegative().max(2_147_483_646).optional(),
  })
  .refine((value) => (value.channelId === undefined) === (value.expectedGeneration === undefined), {
    message: "Reconnect requires the channel and its saved credential generation",
  });
export type LinkedInAuthorizationStart = z.infer<typeof linkedinAuthorizationStartSchema>;

/** Preserve duplicate callback parameters for the maintained OAuth validator. */
export const linkedinAuthorizationCompleteSchema = z.strictObject({
  parameters: z.string().min(1).max(8192),
});
export const linkedinAuthorizationStartedSchema = z.object({
  authorizationUrl: z.url().refine((value) => {
    const url = new URL(value);
    return (
      url.origin === "https://www.linkedin.com" &&
      url.pathname === "/oauth/v2/authorization" &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  }),
});
export const linkedinAuthorizationCompletedSchema = z.object({
  brandId: z.uuid(),
  channelId: z.uuid(),
  locale: z.enum(LINKEDIN_AUTHORIZATION_LOCALES),
});
export const linkedinDisconnectSchema = z.strictObject({
  expectedGeneration: z.number().int().nonnegative().max(2_147_483_646),
});
export const LINKEDIN_CONNECTION_STATES = [
  "connected",
  "disconnected",
  "expired",
  "reconnect",
] as const;
export const linkedinConnectionSchema = z.object({
  state: z.enum(LINKEDIN_CONNECTION_STATES),
  generation: z.number().int().nonnegative().max(2_147_483_646),
  account: z.string().min(1).max(300).nullable(),
  scopes: z.string().max(2048).nullable(),
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
  connectedAt: z.iso.datetime({ offset: true }).nullable(),
  disconnectedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type LinkedInConnection = z.infer<typeof linkedinConnectionSchema>;
