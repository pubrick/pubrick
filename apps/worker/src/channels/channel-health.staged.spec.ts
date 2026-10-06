import { getPublisher, getStagedPublisher, threadsCredentialsSchema } from "@pubrick/integrations";
import { encryptJson } from "@pubrick/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../env";
import { ChannelHealthService } from "./channel-health.service";

vi.mock("../env", async (original) => ({
  ...(await original<typeof import("../env")>()),
  metaApplications: {
    threads: { clientId: "321", clientSecret: "fixture-app-secret" },
    instagram_native: undefined,
    facebook_page: undefined,
  },
}));

const database = vi.hoisted(() => {
  const limit = vi.fn();
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn(() => ({ where }));
  return {
    limit,
    set,
    where,
    db: {
      select: vi.fn(() => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit }) }) }) })),
      update: vi.fn(() => ({ set })),
    },
  };
});
vi.mock("../db", () => ({ db: database.db }));
vi.mock("@pubrick/integrations", async (original) => ({
  ...(await original<typeof import("@pubrick/integrations")>()),
  getPublisher: vi.fn(),
  getStagedPublisher: vi.fn(),
}));
const direct = vi.mocked(getPublisher);
const staged = vi.mocked(getStagedPublisher);

beforeEach(() => {
  direct.mockReset().mockReturnValue(undefined);
  staged.mockReset();
  database.set.mockClear();
  database.where.mockClear();
  database.limit.mockResolvedValue([
    {
      orgId: "fixture-org",
      id: "00000000-0000-4000-8000-000000000001",
      platform: "threads",
      applicationId: "321",
      generation: 1,
      target: "threads:12345",
      credentialsEncrypted: encryptJson(
        { accessToken: "fixture-token", accountId: "12345" },
        env.APP_ENCRYPTION_KEY,
      ),
    },
  ]);
});

describe("staged publisher health dispatch", () => {
  it("uses the staged verifier without requiring a direct publish wrapper", async () => {
    const verify = vi
      .fn()
      .mockResolvedValue({ ok: true, account: "Writer", target: "threads:12345" });
    staged.mockReturnValue({ credentialsSchema: threadsCredentialsSchema, verify } as never);
    expect(await new ChannelHealthService().scan("fixture-org")).toBe(1);
    expect(staged).toHaveBeenCalledWith("threads");
    expect(verify).toHaveBeenCalledWith(
      { accessToken: "fixture-token", accountId: "12345" },
      { baseUrl: undefined, threads: { clientId: "321", clientSecret: "fixture-app-secret" } },
    );
    expect(database.set).toHaveBeenCalledWith({
      healthOk: true,
      healthCheckedAt: expect.any(Date),
      updatedAt: expect.any(Object),
    });
  });
  it("never probes or marks an old server application healthy", async () => {
    const verify = vi.fn();
    staged.mockReturnValue({ credentialsSchema: threadsCredentialsSchema, verify } as never);
    database.limit.mockResolvedValue([
      {
        orgId: "fixture-org",
        id: "00000000-0000-4000-8000-000000000001",
        platform: "threads",
        applicationId: "999",
        generation: 1,
        target: "threads:12345",
        credentialsEncrypted: encryptJson(
          { accessToken: "fixture-token", accountId: "12345" },
          env.APP_ENCRYPTION_KEY,
        ),
      },
    ]);
    await new ChannelHealthService().scan("fixture-org");
    expect(verify).not.toHaveBeenCalled();
    expect(database.set).toHaveBeenCalledWith(expect.objectContaining({ healthOk: false }));
  });
  it("requires the provider proof to match the immutable saved target", async () => {
    const verify = vi.fn().mockResolvedValue({ ok: true, target: "threads:999" });
    staged.mockReturnValue({ credentialsSchema: threadsCredentialsSchema, verify } as never);
    await new ChannelHealthService().scan("fixture-org");
    expect(database.set).toHaveBeenCalledWith(expect.objectContaining({ healthOk: false }));
  });
  it.each([
    [{ ok: false, reason: "Permission refused" }, false],
    [{ ok: false, reason: "Check inconclusive", indeterminate: true }, null],
  ] as const)("retains the staged verifier's honest verdict %j", async (result, expected) => {
    const verify = vi.fn().mockResolvedValue(result);
    staged.mockReturnValue({ credentialsSchema: threadsCredentialsSchema, verify } as never);
    await new ChannelHealthService().scan("fixture-org");
    expect(database.set).toHaveBeenCalledWith(expect.objectContaining({ healthOk: expected }));
  });
});
