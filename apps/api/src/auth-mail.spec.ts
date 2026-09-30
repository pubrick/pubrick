import { describe, expect, it, vi } from "vitest";
import { createAuthMailer, invitationMailUrl } from "./auth-mail";

const request = {
  kind: "reset" as const,
  userId: "user",
  recipient: "person@example.com",
  link: "https://pubrick.example/api/auth/reset-password/token",
  locale: "en" as const,
};
describe("durable authentication mail dispatcher", () => {
  it("refuses admission before queue readiness without SMTP or sensitive errors", async () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mail = createAuthMailer();
    expect(await mail.submit(request)).toEqual({ status: "unavailable" });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/person@example|token/);
    log.mockRestore();
  });
  it("awaits the committed enqueue rather than claiming delivery", async () => {
    const mail = createAuthMailer();
    let done!: () => void;
    const enqueue = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          done = resolve;
        }),
    );
    mail.bind(enqueue);
    let settled = false;
    const submitted = mail.submit(request).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    done();
    expect(await submitted).toEqual({ status: "queued" });
    expect(enqueue).toHaveBeenCalledWith(request);
    await mail.close();
  });
  it("unbinds immediately on close, drains admitted writes and sanitizes failures", async () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mail = createAuthMailer();
    let reject!: (error: Error) => void;
    const enqueue = vi.fn(
      () =>
        new Promise<void>((_, fail) => {
          reject = fail;
        }),
    );
    mail.bind(enqueue);
    const submitted = mail.submit(request);
    const closing = mail.close();
    expect(await mail.submit(request)).toEqual({ status: "unavailable" });
    expect(enqueue).toHaveBeenCalledTimes(1);
    reject(new Error("smtp credentials private person@example.com token"));
    expect(await submitted).toEqual({ status: "unavailable" });
    await closing;
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/credentials|person@example|token/);
    log.mockRestore();
  });
  it("uses only configured origin and bounded locale for invitations", () => {
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
