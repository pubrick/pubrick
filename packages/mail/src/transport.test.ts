import nodemailer from "nodemailer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMailIdentity, createSmtpMailTransport } from "./index.js";

const now = 1_790_000_000_000;
const identity = createMailIdentity("https://pubrick.example", "hosted", "private-auth-secret");
const payload = {
  purpose: "pubrick-auth-mail" as const,
  version: 1 as const,
  jobId: "a91b4a67-2a4d-45f6-b7ce-a12b0b912ac0",
  identity,
  kind: "reset" as const,
  recipient: "person@example.com",
  locale: "ru" as const,
  userId: "user_1",
  createdAt: now,
  expiresAt: now + 3_600_000,
  messageId: "<pubrick-auth.a91b4a67-2a4d-45f6-b7ce-a12b0b912ac0@pubrick.example>",
  link: "https://pubrick.example/api/auth/reset-password/private-token?callbackURL=%2Fru%2Freset-password",
};
const config = {
  host: "smtp.example",
  port: 587,
  secure: false,
  requireTLS: true,
  auth: { user: "private-user", pass: "private-password" },
  from: "pubrick@example.com",
};
function capture() {
  const sendMail = vi.fn().mockResolvedValue({ accepted: [payload.recipient], rejected: [] });
  const close = vi.fn();
  const create = vi
    .spyOn(nodemailer, "createTransport")
    .mockReturnValue({ sendMail, close } as unknown as ReturnType<
      typeof nodemailer.createTransport
    >);
  return { sendMail, close, create };
}
afterEach(() => vi.restoreAllMocks());
describe("SMTP delivery attempt boundary", () => {
  it("requires authenticated certificate-verified TLS except explicit loopback tests", () => {
    capture();
    expect(() =>
      createSmtpMailTransport({ ...config, requireTLS: false }, { identity }),
    ).toThrowError("configuration");
    expect(() =>
      createSmtpMailTransport({ ...config, auth: { ...config.auth, pass: "" } }, { identity }),
    ).toThrowError("configuration");
    expect(() =>
      createSmtpMailTransport({ ...config, requireTLS: false, host: "127.0.0.1" }, { identity }),
    ).toThrowError("configuration");
    const mail = createSmtpMailTransport(
      { ...config, requireTLS: false, host: "127.0.0.1" },
      { identity, runtime: "test" },
    );
    mail.close();
  });
  it("loads fresh authoritative ownership before every retry and retains a stable Message-ID", async () => {
    const smtp = capture();
    const mail = createSmtpMailTransport(config, { identity, now: () => now });
    const resolve = vi
      .fn()
      .mockResolvedValue({
        user: { id: payload.userId, email: payload.recipient, emailVerified: true },
      });
    expect(await mail.deliver(payload, resolve)).toEqual({ status: "sent" });
    expect(await mail.deliver(payload, resolve)).toEqual({ status: "sent" });
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(smtp.sendMail).toHaveBeenCalledTimes(2);
    expect(smtp.sendMail.mock.calls[0]?.[0]).toMatchObject({
      messageId: payload.messageId,
      to: payload.recipient,
      subject: "Сброс пароля Pubrick",
    });
    expect(smtp.create.mock.calls[0]?.[0]).toMatchObject({
      disableFileAccess: true,
      disableUrlAccess: true,
      logger: false,
      debug: false,
    });
    resolve.mockResolvedValue({
      user: { id: payload.userId, email: "changed@example.com", emailVerified: true },
    });
    expect(await mail.deliver(payload, resolve)).toEqual({
      status: "skipped",
      reason: "recipient_changed",
    });
    expect(smtp.sendMail).toHaveBeenCalledTimes(2);
    mail.close();
  });
  it("does no SMTP I/O for expired/foreign identity jobs and rechecks deadline after an ownership lookup", async () => {
    const smtp = capture();
    let clock = payload.expiresAt;
    const mail = createSmtpMailTransport(config, { identity, now: () => clock });
    const resolve = vi.fn(async () => {
      clock = payload.expiresAt;
      return { user: { id: payload.userId, email: payload.recipient, emailVerified: true } };
    });
    expect(await mail.deliver(payload, resolve)).toEqual({ status: "skipped", reason: "expired" });
    expect(resolve).not.toHaveBeenCalled();
    clock = now;
    expect(
      await mail.deliver(
        {
          ...payload,
          identity: createMailIdentity("https://other.example", "hosted", "private-auth-secret"),
        },
        resolve,
      ),
    ).toEqual({ status: "skipped", reason: "identity_mismatch" });
    expect(await mail.deliver(payload, resolve)).toEqual({ status: "skipped", reason: "expired" });
    expect(smtp.sendMail).not.toHaveBeenCalled();
  });
  it.each([
    [{ code: "EAUTH", message: "private-password" }, "authentication"],
    [{ responseCode: 550, message: "person@example.com" }, "rejected"],
    [{ responseCode: 451, message: "private-token" }, "transient"],
    [{ code: "ETIMEDOUT", message: "private-token" }, "timeout"],
    [new Error("private-password person@example.com private-token"), "unavailable"],
  ])("sanitizes SMTP failure %j", async (failure, code) => {
    const smtp = capture();
    smtp.sendMail.mockRejectedValue(failure);
    const mail = createSmtpMailTransport(config, { identity, now: () => now });
    const promise = mail.deliver(payload, async () => ({
      user: { id: payload.userId, email: payload.recipient, emailVerified: true },
    }));
    await expect(promise).rejects.toMatchObject({ name: "AuthMailError", code, message: code });
    try {
      await promise;
    } catch (error) {
      expect(JSON.stringify(error)).not.toMatch(/private-|person@example/);
    }
  });
  it("refuses a resolved SMTP response that accepted no requested recipient", async () => {
    const smtp = capture();
    smtp.sendMail.mockResolvedValue({ accepted: [], rejected: [payload.recipient] });
    const mail = createSmtpMailTransport(config, { identity, now: () => now });
    await expect(
      mail.deliver(payload, async () => ({
        user: { id: payload.userId, email: payload.recipient, emailVerified: true },
      })),
    ).rejects.toThrowError("rejected");
  });
});
