import { z } from "zod";
import { AuthMailError } from "./payload.js";
import type { SmtpMailConfig } from "./smtp.js";

const optional = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);
export const mailEnvironmentSchema = z.object({
  SMTP_HOST: optional,
  SMTP_USER: optional,
  SMTP_PASSWORD: optional,
  SMTP_FROM: z.preprocess((value) => (value === "" ? undefined : value), z.email().optional()),
  SMTP_PORT: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.coerce.number().int().min(1).max(65535).default(587),
  ),
  SMTP_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  SMTP_REQUIRE_TLS: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
});
export type MailEnvironment = z.output<typeof mailEnvironmentSchema>;
export function resolveSmtpConfig(
  env: MailEnvironment,
  options: { required?: boolean; nodeEnvironment?: string } = {},
): SmtpMailConfig | null {
  const configured = !!(env.SMTP_HOST || env.SMTP_USER || env.SMTP_PASSWORD || env.SMTP_FROM);
  if (!configured && !options.required) return null;
  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASSWORD || !env.SMTP_FROM)
    throw new AuthMailError("configuration");
  const runtime = options.nodeEnvironment ?? process.env.NODE_ENV;
  const local =
    runtime !== "production" && ["localhost", "127.0.0.1", "::1"].includes(env.SMTP_HOST);
  if (!env.SMTP_SECURE && !env.SMTP_REQUIRE_TLS && !local) throw new AuthMailError("configuration");
  return {
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    requireTLS: env.SMTP_REQUIRE_TLS,
    from: env.SMTP_FROM,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
  };
}
