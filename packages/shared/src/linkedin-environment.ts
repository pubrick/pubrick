import { z } from "zod";

const optional = (schema: z.ZodString) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());
/** Server application secrets are optional together; tenants cannot choose the application. */
export const linkedinEnvironmentSchema = z.object({
  LINKEDIN_CLIENT_ID: optional(
    z
      .string()
      .min(1)
      .max(200)
      .regex(/^[\x21-\x7e]+$/),
  ),
  LINKEDIN_CLIENT_SECRET: optional(
    z
      .string()
      .min(1)
      .max(8192)
      .refine((value) => value.trim().length > 0),
  ),
});
export function linkedinApplicationConfiguration(
  values: z.infer<typeof linkedinEnvironmentSchema>,
) {
  if (Boolean(values.LINKEDIN_CLIENT_ID) !== Boolean(values.LINKEDIN_CLIENT_SECRET))
    throw new Error("Set both LinkedIn application credentials, or leave both unset");
  return values.LINKEDIN_CLIENT_ID && values.LINKEDIN_CLIENT_SECRET
    ? { clientId: values.LINKEDIN_CLIENT_ID, clientSecret: values.LINKEDIN_CLIENT_SECRET }
    : undefined;
}
