import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PermanentPublishError } from "@pubrick/integrations";
import { openMetaMediaAccess } from "@pubrick/shared";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StagedAssets } from "./staged-assets";
import type { StageLease } from "./staged-publication.contract";

const fixture = vi.hoisted(() => ({
  directory: "",
  origin: "https://pubrick.example.com",
  rows: vi.fn(),
  key: "bW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW1tbW0=",
}));
vi.mock("../env", () => ({
  env: {
    get MEDIA_STORAGE_DIR() {
      return fixture.directory;
    },
    get WEB_ORIGIN() {
      return fixture.origin;
    },
    APP_ENCRYPTION_KEY: fixture.key,
  },
}));
vi.mock("../db", () => ({ db: { select: () => ({ from: () => ({ where: fixture.rows }) }) } }));
const id = "00000000-0000-4000-8000-000000000001";
const brandId = "00000000-0000-4000-8000-000000000002";
let bytes: Buffer;
let asset: {
  id: string;
  kind: string;
  mimeType: string;
  width: number;
  height: number;
  byteSize: number;
};
let service: StagedAssets;
const authorized = vi.fn();
beforeEach(async () => {
  fixture.directory = await mkdtemp(path.join(tmpdir(), "pubrick-meta-assets-"));
  fixture.origin = "https://pubrick.example.com";
  bytes = await sharp({ create: { width: 400, height: 500, channels: 3, background: "#fafafa" } })
    .jpeg()
    .toBuffer();
  await writeFile(path.join(fixture.directory, `${id}.jpg`), bytes);
  asset = {
    id,
    kind: "image",
    mimeType: "image/jpeg",
    width: 400,
    height: 500,
    byteSize: bytes.length,
  };
  fixture.rows.mockReset().mockResolvedValue([asset]);
  authorized.mockReset().mockResolvedValue(true);
  service = new StagedAssets({ authorized } as never);
});
afterEach(async () => {
  await rm(fixture.directory, { recursive: true, force: true });
});
function lease(): StageLease {
  return {
    id,
    contentItemId: id,
    applicationId: "321",
    identity: {
      orgId: "fixture-org",
      brandId,
      adaptationId: id,
      channelId: id,
      attempt: 1,
      inputHash: "a".repeat(64),
      target: "instagram:12345",
      credentialGeneration: 1,
    },
    input: {
      version: 1,
      platform: "instagram_native",
      text: "Reviewed",
      image: {
        mediaId: id,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        mimeType: "image/jpeg",
        width: 400,
        height: 500,
        byteSize: bytes.length,
      },
    },
    phase: "preparation_intent",
    containerId: null,
    claim: null,
    leaseToken: id,
    deadline: new Date(Date.now() + 300_000),
    pollCount: 0,
    ciphertext: "private",
  };
}
describe("exact approved Instagram JPEG", () => {
  it("decodes the actual bytes and freezes their exact identity and hash", async () => {
    expect(await service.snapshot("fixture-org", brandId, id)).toEqual(lease().input.image);
  });
  it.each(["size", "dimensions", "format", "colour", "orientation", "ratio", "width"])(
    "refuses a %s mismatch using the actual stored file",
    async (kind) => {
      if (kind === "size") asset.byteSize++;
      if (kind === "dimensions") asset.width++;
      if (kind === "format") {
        bytes = await sharp(bytes).png().toBuffer();
        asset.byteSize = bytes.length;
      }
      if (kind === "colour") {
        bytes = await sharp(bytes).toColourspace("cmyk").jpeg().toBuffer();
        asset.byteSize = bytes.length;
      }
      if (kind === "orientation") {
        bytes = await sharp(bytes).withMetadata({ orientation: 6 }).jpeg().toBuffer();
        asset.byteSize = bytes.length;
      }
      if (kind === "ratio" || kind === "width") {
        const width = kind === "ratio" ? 400 : 1441;
        const height = kind === "ratio" ? 600 : 1441;
        bytes = await sharp({ create: { width, height, channels: 3, background: "#ffffff" } })
          .jpeg()
          .toBuffer();
        asset.width = width;
        asset.height = height;
        asset.byteSize = bytes.length;
      }
      await writeFile(path.join(fixture.directory, `${id}.jpg`), bytes);
      await expect(service.snapshot("fixture-org", brandId, id)).rejects.toThrow(
        PermanentPublishError,
      );
    },
  );
  it("refuses a missing or another tenant's metadata before reading a file", async () => {
    fixture.rows.mockResolvedValue([]);
    await expect(service.snapshot("other", brandId, id)).rejects.toThrow(PermanentPublishError);
  });
  it("issues an encrypted capability only for the unchanged bytes and current attempt", async () => {
    const stage = lease();
    const now = new Date();
    fixture.rows.mockResolvedValueOnce([asset]).mockResolvedValueOnce([{ now }]);
    const result = await service.capability("fixture-org", stage);
    expect(authorized).toHaveBeenCalledWith("fixture-org", stage, "preparation_intent");
    const token = new URL(result.url).pathname.split("/").at(-1);
    expect(token).toBeDefined();
    const claim = openMetaMediaAccess("fixture-org", token as string, fixture.key, now.getTime());
    expect(claim.identity).toEqual(stage.identity);
    expect(claim.image).toEqual(stage.input.image);
    expect(Date.parse(claim.expiresAt) - now.getTime()).toBeLessThanOrEqual(300_000);
    expect(result.url).not.toContain("private");
  });
  it.each(["bytes", "authority", "tenant", "origin", "deadline"])(
    "refuses %s changes without issuing access",
    async (kind) => {
      const stage = lease();
      if (kind === "bytes" && stage.input.image) stage.input.image.sha256 = "b".repeat(64);
      if (kind === "authority") authorized.mockResolvedValue(false);
      if (kind === "tenant") stage.identity.orgId = "other";
      if (kind === "origin") fixture.origin = "http://localhost:3000";
      if (kind === "deadline") stage.deadline = new Date(Date.now() + 20_000);
      fixture.rows.mockResolvedValueOnce([asset]).mockResolvedValueOnce([{ now: new Date() }]);
      await expect(service.capability("fixture-org", stage)).rejects.toThrow(PermanentPublishError);
    },
  );
});
