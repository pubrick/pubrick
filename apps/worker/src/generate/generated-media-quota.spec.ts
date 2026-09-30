import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GenerateRepository } from "./generate.repository";

const mocks = vi.hoisted(() => ({ admission: vi.fn(), insert: vi.fn(), values: vi.fn() }));
vi.mock("../db", () => ({ db: {}, pool: {} }));
vi.mock("../env", () => ({ env: {} }));
vi.mock("@pubrick/db", async (original) => ({
  ...(await original<typeof import("@pubrick/db")>()),
  withTenantResourceAdmission: mocks.admission,
}));
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "pubrick-generated-quota-"));
  vi.stubEnv("MEDIA_STORAGE_DIR", directory);
  vi.stubEnv("PUBRICK_DEPLOYMENT_MODE", "hosted");
  vi.stubEnv("BILLING_DRIVER", "fixture");
  vi.stubEnv("BILLING_ACCOUNT_ID", "fixture_generated_quota");
  vi.stubEnv("NODE_ENV", "test");
  mocks.admission.mockReset();
  mocks.insert.mockReset();
  mocks.values.mockReset();
  mocks.insert.mockReturnValue({ values: mocks.values });
  mocks.values.mockResolvedValue(undefined);
  mocks.admission.mockImplementation(async (_org, _db, _mode, _growth, insert) =>
    insert({ insert: mocks.insert }),
  );
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});
async function sourceImage() {
  return sharp({ create: { width: 32, height: 32, channels: 3, background: "red" } })
    .png()
    .toBuffer();
}

it("admits the exact normalized JPEG bytes and inserts only inside the admission callback", async () => {
  const input = await sourceImage();
  const id = await new GenerateRepository().saveGeneratedImage(
    "org_generated",
    "brand_generated",
    input,
    "cover",
  );
  const bytes = await readFile(path.join(directory, `${id}.jpg`));
  expect((await sharp(bytes).metadata()).format).toBe("jpeg");
  expect(mocks.admission).toHaveBeenCalledExactlyOnceWith(
    "org_generated",
    {},
    {
      mode: "hosted",
      identity: {
        provider: "fixture",
        environment: "sandbox",
        accountId: "fixture_generated_quota",
      },
    },
    { resource: "mediaBytes", additional: bytes.length },
    expect.any(Function),
  );
  expect(mocks.values).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      id,
      orgId: "org_generated",
      brandId: "brand_generated",
      byteSize: bytes.length,
    }),
  );
});
it.each(["quota refusal", "tenant or brand deleted"])(
  "removes normalized files after %s without an orphan DB row",
  async (reason) => {
    const failure = new Error(reason);
    if (reason === "quota refusal") mocks.admission.mockRejectedValue(failure);
    else mocks.values.mockRejectedValue(failure);
    await expect(
      new GenerateRepository().saveGeneratedImage(
        "org_generated",
        "brand_generated",
        await sourceImage(),
        "inline",
      ),
    ).rejects.toBe(failure);
    expect(await readdir(directory)).toEqual([]);
    if (reason === "quota refusal") expect(mocks.values).not.toHaveBeenCalled();
  },
);
it("preserves the explicit self-hosted bypass without requiring a payment identity", async () => {
  vi.stubEnv("PUBRICK_DEPLOYMENT_MODE", "self-hosted");
  vi.stubEnv("BILLING_DRIVER", "unused");
  await new GenerateRepository().saveGeneratedImage(
    "org_generated",
    "brand_generated",
    await sourceImage(),
    "cover",
  );
  expect(mocks.admission.mock.calls[0]?.[2]).toEqual({ mode: "self-hosted" });
});
