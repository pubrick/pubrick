import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type MediaCleanupClaim, type MediaCleanupRepository } from "./media-cleanup.repository";
import { MediaCleanupService, unlinkMediaCleanupFile } from "./media-cleanup.service";

const config = vi.hoisted(() => ({ root: "" }));
vi.mock("../env", () => ({
  env: {
    get MEDIA_STORAGE_DIR() {
      return config.root;
    },
  },
}));
vi.mock("./media-cleanup.repository", () => ({ MediaCleanupRepository: class {} }));
const directories: string[] = [];
async function directory() {
  const root = await mkdtemp(path.join(tmpdir(), "pubrick-media-cleanup-"));
  directories.push(root);
  return root;
}
function claim(kind: "image" | "video" = "image"): MediaCleanupClaim {
  return {
    assetId: randomUUID(),
    orgId: "deleted-org",
    kind,
    attempts: 1,
    leaseToken: randomUUID(),
  };
}
function repository(claims: MediaCleanupClaim[]) {
  const repo = {
    claim: vi.fn(async () => claims),
    complete: vi.fn(async () => true),
    fail: vi.fn(async () => true),
    prune: vi.fn(async () => 0),
  };
  // Only the explicit repository port is exercised; no database in filesystem tests.
  return { ...repo, service: new MediaCleanupService(repo as unknown as MediaCleanupRepository) };
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
describe("physical media cleanup", () => {
  it.each(["image", "video"] as const)(
    "unlinks the canonical %s file and leaves adjacent files intact",
    async (kind) => {
      const root = await directory();
      const item = claim(kind);
      const target = path.join(root, `${item.assetId}.${kind === "image" ? "jpg" : "mp4"}`);
      const adjacent = path.join(root, `${randomUUID()}.jpg`);
      await writeFile(target, "deleted");
      await writeFile(adjacent, "retained");
      await unlinkMediaCleanupFile(root, item);
      await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(adjacent, "utf8")).toBe("retained");
    },
  );
  it("removes an asset symlink itself without following its external target", async () => {
    const root = await directory();
    const outside = await directory();
    const item = claim();
    const target = path.join(outside, "retained.jpg");
    await writeFile(target, "retained");
    await symlink(target, path.join(root, `${item.assetId}.jpg`));
    await unlinkMediaCleanupFile(root, item);
    expect(await readFile(target, "utf8")).toBe("retained");
  });
  it("refuses a symlinked configured directory and traversal identifiers", async () => {
    const root = await directory();
    const outside = await directory();
    const linked = path.join(root, "linked");
    await symlink(outside, linked);
    await expect(unlinkMediaCleanupFile(linked, claim())).rejects.toThrow();
    await expect(
      unlinkMediaCleanupFile(root, { assetId: "../retained", kind: "image" }),
    ).rejects.toThrow();
  });
  it("completes an already missing asset, but retries a missing storage directory", async () => {
    const item = claim();
    config.root = await directory();
    const repo = repository([item]);
    await repo.service.tick();
    expect(repo.complete).toHaveBeenCalledWith(item);
    expect(repo.fail).not.toHaveBeenCalled();
    config.root = path.join(config.root, "not-mounted");
    const missing = repository([item]);
    await missing.service.tick();
    expect(missing.complete).not.toHaveBeenCalled();
    expect(missing.fail).toHaveBeenCalledWith(item, "storage_unavailable");
  });
  it("does not acknowledge unsafe paths as successful removal", async () => {
    config.root = await directory();
    const item = { ...claim(), assetId: "../outside" };
    const repo = repository([item]);
    await repo.service.tick();
    expect(repo.fail).toHaveBeenCalledWith(item, "invalid_path");
    expect(repo.complete).not.toHaveBeenCalled();
  });
  it("does not overlap an in-flight poll or disguise a failed DB acknowledgement as a disk error", async () => {
    config.root = await directory();
    const item = claim();
    const repo = repository([item]);
    let resolve!: () => void;
    const barrier = new Promise<void>((done) => {
      resolve = done;
    });
    repo.claim.mockImplementation(async () => {
      await barrier;
      return [item];
    });
    const first = repo.service.tick();
    await repo.service.tick();
    expect(repo.claim).toHaveBeenCalledTimes(1);
    resolve();
    await first;
    const error = new Error("database unavailable");
    repo.complete.mockRejectedValueOnce(error);
    await expect(repo.service.tick()).rejects.toBe(error);
    expect(repo.fail).not.toHaveBeenCalled();
  });
});
