import { z } from "zod";
import { linkedinConnectionSchema } from "./linkedin-connections.js";

/** OAuth modes, not a promise that a public channel has a publishing capability. */
export const META_CONNECTION_PROVIDERS = ["threads", "instagram_native", "facebook_page"] as const;
export type MetaConnectionProvider = (typeof META_CONNECTION_PROVIDERS)[number];
export const META_AUTHORIZATION_TTL_SECONDS = 10 * 60;
export const META_MAX_AUTHORIZATION_REQUESTS = 100;
export const META_MAX_DISCOVERED_PAGES = 50;

export const metaAuthorizationStartSchema = z
  .strictObject({
    provider: z.enum(META_CONNECTION_PROVIDERS),
    brandId: z.uuid(),
    name: z.string().trim().min(1).max(200),
    locale: z.enum(["en", "es", "ru", "pt"]),
    channelId: z.uuid().optional(),
    expectedGeneration: z.number().int().nonnegative().max(2_147_483_646).optional(),
  })
  .refine((value) => (value.channelId === undefined) === (value.expectedGeneration === undefined), {
    message: "A reconnect needs both the saved channel and its credential generation",
  });
export type MetaAuthorizationStart = z.infer<typeof metaAuthorizationStartSchema>;

/** Validate a server response before navigating away from the application. */
export const metaAuthorizationStartedSchema = z
  .strictObject({
    provider: z.enum(META_CONNECTION_PROVIDERS),
    authorizationUrl: z.url().max(8192),
  })
  .refine(({ provider, authorizationUrl }) => {
    const url = new URL(authorizationUrl);
    const expected =
      provider === "threads"
        ? "https://www.threads.com/oauth/authorize"
        : provider === "instagram_native"
          ? "https://www.instagram.com/oauth/authorize"
          : "https://www.facebook.com/v26.0/dialog/oauth";
    return (
      `${url.origin}${url.pathname}` === expected && !url.username && !url.password && !url.hash
    );
  });

/** Managed connections share the same public lifecycle; secrets and app lineage stay on the server. */
export const metaConnectionSchema = linkedinConnectionSchema;
export type MetaConnection = z.infer<typeof metaConnectionSchema>;

export const metaAuthorizationCompleteSchema = z.strictObject({
  provider: z.enum(META_CONNECTION_PROVIDERS),
  parameters: z.string().min(1).max(8192),
});
export const metaDisconnectSchema = z.strictObject({
  expectedGeneration: z.number().int().nonnegative().max(2_147_483_646),
});
export const metaPageSelectionSchema = z.strictObject({
  requestId: z.uuid(),
  pageId: z.string().regex(/^[1-9]\d{0,30}$/),
});
export const metaAuthorizationCompletedSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("connected"),
    brandId: z.uuid(),
    channelId: z.uuid(),
    locale: z.enum(["en", "es", "ru", "pt"]),
  }),
  z.strictObject({
    status: z.literal("choose_page"),
    requestId: z.uuid(),
    brandId: z.uuid(),
    locale: z.enum(["en", "es", "ru", "pt"]),
    expiresAt: z.iso.datetime({ offset: true }),
    pages: z
      .array(
        z.strictObject({
          id: z.string().regex(/^[1-9]\d{0,30}$/),
          name: z.string().min(1).max(300),
        }),
      )
      .min(1)
      .max(META_MAX_DISCOVERED_PAGES),
  }),
]);
export type MetaAuthorizationCompleted = z.infer<typeof metaAuthorizationCompletedSchema>;
