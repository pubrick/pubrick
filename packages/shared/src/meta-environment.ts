import { z } from "zod";
import type { MetaConnectionProvider } from "./dto/meta-connections.js";

/** Upgrade only with matching transport fixtures and official API contract review. */
export const META_GRAPH_API_VERSION = "v26.0" as const;

const optional = (schema: z.ZodString) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());
export const metaApplicationCredentialsSchema = z.strictObject({
  clientId: z.string().regex(/^[1-9]\d{0,30}$/),
  clientSecret: z
    .string()
    .min(1)
    .max(8192)
    .regex(/^[\x21-\x7e]+$/),
});
const clientId = optional(metaApplicationCredentialsSchema.shape.clientId);
const clientSecret = optional(metaApplicationCredentialsSchema.shape.clientSecret);

/** Separate confidential applications; these values never belong to a tenant request. */
export const metaEnvironmentSchema = z.object({
  THREADS_CLIENT_ID: clientId,
  THREADS_CLIENT_SECRET: clientSecret,
  INSTAGRAM_CLIENT_ID: clientId,
  INSTAGRAM_CLIENT_SECRET: clientSecret,
  FACEBOOK_CLIENT_ID: clientId,
  FACEBOOK_CLIENT_SECRET: clientSecret,
  // Verified Graph examples use v26.0. Threads has its own independent version contract.
  META_GRAPH_API_VERSION: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.literal(META_GRAPH_API_VERSION).default(META_GRAPH_API_VERSION),
  ),
});
export type MetaEnvironment = z.infer<typeof metaEnvironmentSchema>;
export type MetaApplicationCredentials = z.infer<typeof metaApplicationCredentialsSchema>;

export function metaApplicationConfigurations(
  values: MetaEnvironment,
): Record<MetaConnectionProvider, MetaApplicationCredentials | undefined> {
  const pair = (
    provider: MetaConnectionProvider,
    id: string | undefined,
    secret: string | undefined,
  ): MetaApplicationCredentials | undefined => {
    if (Boolean(id) !== Boolean(secret))
      throw new Error(`Set both ${provider} application credentials, or leave both unset`);
    return id && secret ? { clientId: id, clientSecret: secret } : undefined;
  };
  return {
    threads: pair("threads", values.THREADS_CLIENT_ID, values.THREADS_CLIENT_SECRET),
    instagram_native: pair(
      "instagram_native",
      values.INSTAGRAM_CLIENT_ID,
      values.INSTAGRAM_CLIENT_SECRET,
    ),
    facebook_page: pair("facebook_page", values.FACEBOOK_CLIENT_ID, values.FACEBOOK_CLIENT_SECRET),
  };
}
