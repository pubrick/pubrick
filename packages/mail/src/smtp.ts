import nodemailer from "nodemailer";
import { z } from "zod";
import {
  AuthMailError,
  type AuthMailPayload,
  type DeliveryEligibility,
  deliveryEligibility,
  type MailIdentity,
  type MailOwnershipSnapshot,
  validateAuthMail,
} from "./payload.js";

const smtpSchema = z
  .object({
    host: z.string().trim().min(1).max(253),
    port: z.number().int().min(1).max(65535),
    secure: z.boolean(),
    requireTLS: z.boolean(),
    from: z.email().max(512),
    auth: z
      .object({ user: z.string().min(1).max(1024), pass: z.string().min(1).max(4096) })
      .strict(),
  })
  .strict();
export type SmtpMailConfig = z.infer<typeof smtpSchema>;
export type AuthMailDeliveryResult =
  | Readonly<{ status: "sent" }>
  | Readonly<{ status: "skipped"; reason: Exclude<DeliveryEligibility, "eligible"> }>;
export type OwnershipResolver = (payload: AuthMailPayload) => Promise<MailOwnershipSnapshot>;
const copy = {
  en: {
    verify: "Confirm your Pubrick email address",
    reset: "Reset your Pubrick password",
    invite: "You are invited to a Pubrick workspace",
    action: "Open this link to continue:",
    ignore: "If you did not request this, you can ignore this email.",
  },
  es: {
    verify: "Confirma tu correo de Pubrick",
    reset: "Restablece tu contraseña de Pubrick",
    invite: "Te han invitado a un espacio de Pubrick",
    action: "Abre este enlace para continuar:",
    ignore: "Si no lo solicitaste, puedes ignorar este correo.",
  },
  ru: {
    verify: "Подтвердите адрес почты в Pubrick",
    reset: "Сброс пароля Pubrick",
    invite: "Приглашение в рабочую область Pubrick",
    action: "Откройте ссылку, чтобы продолжить:",
    ignore: "Если вы не запрашивали это действие, проигнорируйте письмо.",
  },
  pt: {
    verify: "Confirme seu email do Pubrick",
    reset: "Redefina sua senha do Pubrick",
    invite: "Convite para um espaço do Pubrick",
    action: "Abra este link para continuar:",
    ignore: "Se você não solicitou isso, ignore este email.",
  },
};
function failureCode(error: unknown): AuthMailError {
  if (error instanceof AuthMailError) return error;
  if (error && typeof error === "object") {
    const code = "code" in error ? error.code : undefined;
    const responseCode = "responseCode" in error ? error.responseCode : undefined;
    if (code === "EAUTH") return new AuthMailError("authentication");
    if (code === "ETIMEDOUT") return new AuthMailError("timeout");
    if (typeof responseCode === "number" && responseCode >= 500)
      return new AuthMailError("rejected");
    if (typeof responseCode === "number" && responseCode >= 400)
      return new AuthMailError("transient");
  }
  return new AuthMailError("unavailable");
}
/** One SMTP attempt only. pg-boss will own retries and distributed concurrency. */
export function createSmtpMailTransport(
  input: SmtpMailConfig,
  options: {
    identity: MailIdentity;
    runtime?: "production" | "development" | "test";
    now?: () => number;
  },
) {
  let config: SmtpMailConfig;
  try {
    config = smtpSchema.parse(input);
    const localTest =
      options.runtime === "test" && ["localhost", "127.0.0.1", "::1"].includes(config.host);
    if (!config.secure && !config.requireTLS && !localTest) throw new Error("TLS");
  } catch {
    throw new AuthMailError("configuration");
  }
  const { from, ...connection } = config;
  const client = nodemailer.createTransport({
    ...connection,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
  });
  const now = options.now ?? Date.now;
  let closed = false;
  return {
    async deliver(
      value: AuthMailPayload,
      resolveOwnership: OwnershipResolver,
    ): Promise<AuthMailDeliveryResult> {
      if (closed) throw new AuthMailError("unavailable");
      // A restored job for another domain/mode/auth secret never queries account
      // state or sends mail. Decoding callers also validate the encrypted schema.
      if (
        value.identity.origin !== options.identity.origin ||
        value.identity.deploymentMode !== options.identity.deploymentMode ||
        value.identity.authSecretId !== options.identity.authSecretId
      )
        return { status: "skipped", reason: "identity_mismatch" };
      const payload = validateAuthMail(value);
      const basic = deliveryEligibility(payload, options.identity, now(), {});
      if (basic !== "missing_target")
        return { status: "skipped", reason: basic as Exclude<DeliveryEligibility, "eligible"> };
      let snapshot: MailOwnershipSnapshot;
      try {
        snapshot = await resolveOwnership(payload);
      } catch {
        throw new AuthMailError("unavailable");
      }
      const eligibility = deliveryEligibility(payload, options.identity, now(), snapshot);
      if (eligibility !== "eligible") return { status: "skipped", reason: eligibility };
      const words = copy[payload.locale];
      try {
        const result = await client.sendMail({
          from,
          to: payload.recipient,
          messageId: payload.messageId,
          subject: words[payload.kind],
          text: `${words.action}\n\n${payload.link}\n\n${words.ignore}`,
          disableFileAccess: true,
          disableUrlAccess: true,
        });
        const accepted = result.accepted.some(
          (address) =>
            (typeof address === "string" ? address : address.address)?.toLowerCase() ===
            payload.recipient.toLowerCase(),
        );
        if (!accepted) throw new AuthMailError("rejected");
        return { status: "sent" };
      } catch (error) {
        throw failureCode(error);
      }
    },
    close() {
      closed = true;
      client.close();
    },
  };
}
