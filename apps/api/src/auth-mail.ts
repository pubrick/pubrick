import nodemailer from "nodemailer";
import pLimit from "p-limit";
import { canonicalMailUrl, type identityConfig } from "./auth-hosted-policy";

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
type MailKind = "verify" | "reset" | "invite";
type MailConfig = NonNullable<ReturnType<typeof identityConfig>["mail"]>;
export function createAuthMailer(origin: string, config: MailConfig) {
  const { from, ...transport } = config;
  const mailer = nodemailer.createTransport({
    ...transport,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  const limit = pLimit({ concurrency: 4, rejectOnClear: true });
  const deliveries = new Set<Promise<unknown>>();
  let closed = false;
  async function send(kind: MailKind, to: string, link: string, request?: Request) {
    try {
      const locale = request?.headers.get("x-pubrick-locale");
      const words =
        copy[locale && Object.hasOwn(copy, locale) ? (locale as keyof typeof copy) : "en"];
      if (kind === "invite") {
        const invitation = new URL(link);
        if (
          invitation.origin !== new URL(origin).origin ||
          !/^\/(en|es|ru|pt)\/onboarding$/.test(invitation.pathname)
        )
          throw new Error("Unsafe invitation link.");
      } else link = canonicalMailUrl(link, origin);
      await mailer.sendMail({
        from,
        to,
        subject: words[kind],
        text: `${words.action}\n\n${link}\n\n${words.ignore}`,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      return true;
    } catch {
      // SMTP errors can include recipients, credentials and signed links. A
      // known address must also not turn a provider outage into enumeration.
      console.warn("Authentication email delivery failed. Inspect SMTP configuration locally.");
      return false;
    }
  }
  return {
    send,
    // Every auth callback returns before SMTP I/O. Slow delivery must not reveal
    // whether an unauthenticated email address exists. p-limit owns concurrency.
    submit(kind: MailKind, to: string, link: string, request?: Request) {
      if (closed || limit.activeCount + limit.pendingCount >= 12) {
        console.warn(
          "Authentication email delivery unavailable. Retry after checking SMTP capacity.",
        );
        return;
      }
      const delivery = limit(() => send(kind, to, link, request)).catch(() => false);
      deliveries.add(delivery);
      void delivery.finally(() => deliveries.delete(delivery));
    },
    async drain() {
      await Promise.allSettled([...deliveries]);
    },
    async close() {
      closed = true;
      limit.clearQueue();
      await Promise.allSettled([...deliveries]);
      mailer.close();
    },
  };
}
export function invitationMailUrl(origin: string, invitationId: string, request?: Request) {
  const rawLocale = request?.headers.get("x-pubrick-locale");
  const locale = rawLocale && Object.hasOwn(copy, rawLocale) ? rawLocale : "en";
  const url = new URL(`/${locale}/onboarding`, origin);
  url.searchParams.set("invitation", invitationId);
  return url.href;
}
