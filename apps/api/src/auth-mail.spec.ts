import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { SMTPServer } from "smtp-server";
import { describe, expect, it, vi } from "vitest";
import { createAuthMailer, invitationMailUrl } from "./auth-mail";

async function captureServer() {
  const messages: string[] = [];
  const server = new SMTPServer({
    disabledCommands: ["STARTTLS"],
    allowInsecureAuth: true,
    logger: false,
    onAuth(auth, _session, callback) {
      callback(
        auth.username === "account" && auth.password === "private" ? null : new Error("Rejected"),
        { user: "account" },
      );
    },
    onData(stream, _session, callback) {
      let body = "";
      stream.on("data", (chunk) => {
        body += chunk.toString();
      });
      stream.on("end", () => {
        messages.push(body);
        callback();
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.server.address();
  if (!address || typeof address === "string") throw new Error("Missing local SMTP port");
  return {
    messages,
    port: address.port,
    close: () => new Promise<void>((resolve) => server.close(resolve)),
  };
}
describe("authentication mail through maintained SMTP transport", () => {
  it("sends canonical confirmation links through an isolated authenticated SMTP capture", async () => {
    const capture = await captureServer();
    const mail = createAuthMailer("https://pubrick.example", {
      host: "127.0.0.1",
      port: capture.port,
      secure: false,
      requireTLS: false,
      auth: { user: "account", pass: "private" },
      from: "pubrick@example.com",
    });
    try {
      expect(
        await mail.send(
          "verify",
          "person@example.com",
          "https://pubrick.example/api/auth/verify-email?token=opaque&callbackURL=%2Fen%2Fverify-email",
        ),
      ).toBe(true);
      expect(capture.messages).toHaveLength(1);
      expect(capture.messages[0]).toContain("Subject: Confirm your Pubrick email address");
      const parsed = await simpleParser(capture.messages[0]);
      expect(parsed.text).toContain("token=opaque");
    } finally {
      await mail.close();
      await capture.close();
    }
  });
  it("refuses plaintext transport when STARTTLS is required and logs no recipient, password or token", async () => {
    const capture = await captureServer();
    const logger = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mail = createAuthMailer("https://pubrick.example", {
      host: "127.0.0.1",
      port: capture.port,
      secure: false,
      requireTLS: true,
      auth: { user: "account", pass: "private" },
      from: "pubrick@example.com",
    });
    try {
      expect(
        await mail.send(
          "reset",
          "person@example.com",
          "https://pubrick.example/api/auth/reset-password/opaque?callbackURL=%2Fen%2Freset-password",
        ),
      ).toBe(false);
      expect(capture.messages).toHaveLength(0);
      const logged = JSON.stringify(logger.mock.calls);
      expect(logged).not.toContain("person@example.com");
      expect(logged).not.toContain("private");
      expect(logged).not.toContain("opaque");
    } finally {
      await mail.close();
      logger.mockRestore();
      await capture.close();
    }
  });
  it("submits independently of SMTP latency, bounds work, and cancels queued deliveries on shutdown", async () => {
    const completions: Array<() => void> = [];
    const sendMail = vi.fn(() => new Promise<void>((resolve) => completions.push(resolve)));
    const close = vi.fn();
    const transport = vi.spyOn(nodemailer, "createTransport").mockReturnValue({
      sendMail,
      close,
    } as unknown as ReturnType<typeof nodemailer.createTransport>);
    const logger = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mail = createAuthMailer("https://pubrick.example", {
      host: "smtp.example",
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: "account", pass: "private" },
      from: "pubrick@example.com",
    });
    try {
      for (let index = 0; index < 13; index++) {
        expect(
          mail.submit(
            "reset",
            "person@example.com",
            "https://pubrick.example/api/auth/reset-password/opaque?callbackURL=%2Fen%2Freset-password",
          ),
        ).toBeUndefined();
      }
      await Promise.resolve();
      await Promise.resolve();
      expect(sendMail).toHaveBeenCalledTimes(4);
      expect(logger).toHaveBeenCalledTimes(1);
      const closing = mail.close();
      for (const complete of completions) complete();
      await closing;
      expect(sendMail).toHaveBeenCalledTimes(4);
      expect(close).toHaveBeenCalledOnce();
      mail.submit("reset", "person@example.com", "invalid");
      expect(sendMail).toHaveBeenCalledTimes(4);
      expect(JSON.stringify(logger.mock.calls)).not.toMatch(/private|opaque|person@example/);
    } finally {
      transport.mockRestore();
      logger.mockRestore();
    }
  });
  it("builds invitation links from configured origin and a bounded locale only", () => {
    expect(
      invitationMailUrl(
        "https://pubrick.example",
        "invite",
        new Request("https://unused.example", { headers: { "x-pubrick-locale": "ru" } }),
      ),
    ).toBe("https://pubrick.example/ru/onboarding?invitation=invite");
    expect(
      invitationMailUrl(
        "https://pubrick.example",
        "invite",
        new Request("https://unused.example", { headers: { "x-pubrick-locale": "constructor" } }),
      ),
    ).toBe("https://pubrick.example/en/onboarding?invitation=invite");
  });
});
