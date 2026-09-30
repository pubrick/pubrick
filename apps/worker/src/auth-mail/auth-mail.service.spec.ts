import { randomUUID } from "node:crypto";
import { AUTH_MAIL_QUEUE_OPTIONS, AUTH_MAIL_WORK_OPTIONS } from "@pubrick/shared";
import type { Job, PgBoss } from "pg-boss";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ deliver: vi.fn(), close: vi.fn(), ownership: vi.fn() }));
vi.mock("../env", () => ({
  env: {
    DATABASE_URL: "postgres://unused",
    WEB_ORIGIN: "https://pubrick.example",
    PUBRICK_DEPLOYMENT_MODE: "hosted",
    BETTER_AUTH_SECRET: "fixture-secret",
    APP_ENCRYPTION_KEY: "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=",
  },
  mailConfig: {
    host: "smtp.example",
    port: 587,
    secure: false,
    requireTLS: true,
    auth: { user: "fixture", pass: "fixture" },
    from: "pubrick@example.com",
  },
}));
vi.mock("./auth-mail.repository", () => ({
  AuthMailRepository: class {
    ownership = mocks.ownership;
  },
}));
vi.mock("@pubrick/mail", async (original) => {
  const real = await original<typeof import("@pubrick/mail")>();
  return {
    ...real,
    createSmtpMailTransport: () => ({ deliver: mocks.deliver, close: mocks.close }),
  };
});

import { AuthMailError, createMailIdentity, sealAuthMail } from "@pubrick/mail";
import { AuthMailRepository } from "./auth-mail.repository";
import { AuthMailService } from "./auth-mail.service";

function fixture() {
  const id = randomUUID();
  const now = Date.now();
  const data = sealAuthMail(
    {
      purpose: "pubrick-auth-mail",
      version: 1,
      kind: "reset",
      jobId: id,
      identity: createMailIdentity("https://pubrick.example", "hosted", "fixture-secret"),
      recipient: "synthetic@example.com",
      locale: "en",
      userId: "fixture_user",
      link: "https://pubrick.example/api/auth/reset-password/fixture_token",
      createdAt: now,
      expiresAt: now + 3600000,
      messageId: `<pubrick-auth.${id}@pubrick.example>`,
    },
    "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=",
  );
  return { id, data } as Job<{ ciphertext: string }>;
}
describe("mail worker retry and diagnostic contracts", () => {
  it("uses maintained distributed concurrency and bounded queue attempts", async () => {
    const boss = { createQueue: vi.fn(), updateQueue: vi.fn(), work: vi.fn() };
    const service = new AuthMailService(new AuthMailRepository());
    await service.register(boss as unknown as PgBoss);
    expect(boss.work).toHaveBeenCalledWith(
      "auth-mail",
      AUTH_MAIL_WORK_OPTIONS,
      expect.any(Function),
    );
    expect(AUTH_MAIL_WORK_OPTIONS.groupConcurrency).toBe(4);
    expect(AUTH_MAIL_QUEUE_OPTIONS.retryLimit).toBe(3);
    expect(AUTH_MAIL_QUEUE_OPTIONS.expireInSeconds).toBe(60);
    service.onModuleDestroy();
    expect(mocks.close).toHaveBeenCalled();
  });
  it("preserves only closed retry errors and immediately deadletters permanent rejection", async () => {
    const service = new AuthMailService(new AuthMailRepository());
    mocks.deliver.mockRejectedValueOnce(new AuthMailError("timeout"));
    expect(await service.handle(fixture())).toMatchObject({
      status: "failed",
      output: { code: "timeout" },
    });
    mocks.deliver.mockRejectedValueOnce(new AuthMailError("authentication"));
    expect(await service.handle(fixture())).toMatchObject({
      status: "deadletter",
      output: { code: "authentication" },
    });
    mocks.deliver.mockRejectedValueOnce(new Error("private recipient and signed token"));
    const result = await service.handle(fixture());
    expect(result).toMatchObject({ status: "failed", output: { code: "unavailable" } });
    expect(JSON.stringify(result)).not.toMatch(/private|recipient|token/);
  });
  it("completes malformed encrypted jobs without SMTP or retries", async () => {
    const service = new AuthMailService(new AuthMailRepository());
    mocks.deliver.mockClear();
    expect(
      await service.handle({ id: randomUUID(), data: { ciphertext: "invalid" } } as Job<{
        ciphertext: string;
      }>),
    ).toMatchObject({
      status: "completed",
      output: { status: "skipped", reason: "unreadable_payload" },
    });
    expect(mocks.deliver).not.toHaveBeenCalled();
  });
});
