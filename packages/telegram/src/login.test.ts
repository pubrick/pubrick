import { beforeEach, describe, expect, it, vi } from "vitest";
import { beginTelegramLogin, submitTelegramCode, submitTelegramPassword } from "./login.js";

const fake = vi.hoisted(() => ({
  sendCode: vi.fn(),
  importSession: vi.fn(),
  exportSession: vi.fn(),
  signIn: vi.fn(),
  getPasswordHint: vi.fn(),
  checkPassword: vi.fn(),
  destroy: vi.fn(),
  created: vi.fn(),
}));

vi.mock("@mtcute/core", () => ({ MemoryStorage: class {} }));
vi.mock("@mtcute/node", () => ({
  TelegramClient: class {
    constructor(options: unknown) {
      fake.created(options);
    }
    sendCode = fake.sendCode;
    importSession = fake.importSession;
    exportSession = fake.exportSession;
    signIn = fake.signIn;
    getPasswordHint = fake.getPasswordHint;
    checkPassword = fake.checkPassword;
    destroy = fake.destroy;
  },
}));

const credentials = { apiId: 123, apiHash: "secret" };

describe("resumable Telegram login", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    fake.importSession.mockResolvedValue(undefined);
    fake.exportSession.mockResolvedValue("private-session");
    fake.destroy.mockResolvedValue(undefined);
    fake.getPasswordHint.mockResolvedValue(null);
  });

  it("returns a server-only intermediate session and code hash", async () => {
    fake.sendCode.mockResolvedValue({ phoneCodeHash: "secret-hash", length: 6 });
    await expect(beginTelegramLogin(credentials, "+12025550123")).resolves.toEqual({
      session: "private-session",
      phoneCodeHash: "secret-hash",
      codeLength: 6,
    });
    expect(fake.sendCode).toHaveBeenCalledWith({
      phone: "+12025550123",
      abortSignal: expect.any(AbortSignal),
    });
    expect(fake.destroy).toHaveBeenCalledOnce();
  });

  it("resumes the same session for a successful code", async () => {
    fake.signIn.mockResolvedValue({});
    await expect(
      submitTelegramCode(credentials, "old-session", "+12025550123", "hash", "123456"),
    ).resolves.toEqual({ status: "authorized", session: "private-session" });
    expect(fake.importSession).toHaveBeenCalledWith("old-session");
    expect(fake.signIn).toHaveBeenCalledWith({
      phone: "+12025550123",
      phoneCodeHash: "hash",
      phoneCode: "123456",
      abortSignal: expect.any(AbortSignal),
    });
    expect(fake.destroy).toHaveBeenCalledOnce();
  });

  it("preserves the intermediate session on a 2FA challenge", async () => {
    fake.signIn.mockRejectedValue({ text: "SESSION_PASSWORD_NEEDED" });
    fake.getPasswordHint.mockResolvedValue("pet's name");
    await expect(
      submitTelegramCode(credentials, "old-session", "+12025550123", "hash", "123456"),
    ).resolves.toEqual({
      status: "password_required",
      session: "private-session",
      passwordHint: "pet's name",
    });
    expect(fake.destroy).toHaveBeenCalledOnce();
  });

  it("keeps a 2FA challenge when Telegram cannot return the optional hint", async () => {
    fake.signIn.mockRejectedValue({ text: "SESSION_PASSWORD_NEEDED" });
    fake.getPasswordHint.mockRejectedValue(new Error("provider detail"));
    await expect(
      submitTelegramCode(credentials, "old-session", "+12025550123", "hash", "123456"),
    ).resolves.toEqual({ status: "password_required", session: "private-session" });
  });

  it("resumes a 2FA challenge and exports the authorized session", async () => {
    fake.checkPassword.mockResolvedValue({});
    await expect(submitTelegramPassword(credentials, "partial", "correct horse")).resolves.toEqual({
      session: "private-session",
    });
    expect(fake.importSession).toHaveBeenCalledWith("partial");
    expect(fake.checkPassword).toHaveBeenCalledWith({
      password: "correct horse",
      abortSignal: expect.any(AbortSignal),
    });
    expect(fake.destroy).toHaveBeenCalledOnce();
  });

  it.each([
    [{ text: "PHONE_CODE_INVALID" }, "invalid_code"],
    [{ text: "PHONE_CODE_EXPIRED" }, "code_expired"],
    [{ text: "FLOOD_WAIT_60" }, "rate_limited"],
    [new Error("private provider details"), "unavailable"],
  ])("maps code failure to safe %s", async (providerError, expected) => {
    fake.signIn.mockRejectedValue(providerError);
    await expect(
      submitTelegramCode(credentials, "old-session", "+12025550123", "hash", "000000"),
    ).rejects.toThrow(expected);
    expect(fake.destroy).toHaveBeenCalledOnce();
  });

  it("does not leak an invalid 2FA password", async () => {
    fake.checkPassword.mockRejectedValue({ text: "PASSWORD_HASH_INVALID", secret: "pw" });
    await expect(submitTelegramPassword(credentials, "partial", "pw")).rejects.toThrow(
      "invalid_password",
    );
    expect(fake.destroy).toHaveBeenCalledOnce();
  });

  it("aborts a stalled request and destroys its client", async () => {
    vi.useFakeTimers();
    try {
      fake.sendCode.mockImplementation(() => new Promise(() => undefined));
      const result = beginTelegramLogin(credentials, "+12025550123");
      const rejection = expect(result).rejects.toThrow("unavailable");
      await vi.advanceTimersByTimeAsync(20_000);
      await rejection;
      expect(fake.sendCode.mock.calls[0]?.[0].abortSignal.aborted).toBe(true);
      expect(fake.destroy).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
