import { lstat, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { Injectable, Logger } from "@nestjs/common";
import { env } from "../env";
import {
  type MediaCleanupClaim,
  type MediaCleanupErrorCode,
  MediaCleanupRepository,
} from "./media-cleanup.repository";

class InvalidCleanupPath extends Error {}
class CleanupStorageUnavailable extends Error {}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Unlink never follows an asset symlink; only canonical server-generated basenames are accepted. */
export async function unlinkMediaCleanupFile(
  root: string,
  claim: Pick<MediaCleanupClaim, "assetId" | "kind">,
): Promise<void> {
  if (!uuid.test(claim.assetId) || !["image", "video"].includes(claim.kind))
    throw new InvalidCleanupPath();
  const configured = path.resolve(root);
  let directory: string;
  try {
    const info = await lstat(configured);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new InvalidCleanupPath();
    directory = await realpath(configured);
  } catch (error) {
    if (error instanceof InvalidCleanupPath) throw error;
    throw new CleanupStorageUnavailable();
  }
  const target = path.join(directory, `${claim.assetId}.${claim.kind === "image" ? "jpg" : "mp4"}`);
  await unlink(target);
}
function failureCode(error: unknown): MediaCleanupErrorCode | "missing" {
  if (error instanceof InvalidCleanupPath) return "invalid_path";
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === "ENOENT") return "missing";
  if (code === "EACCES" || code === "EPERM") return "permission";
  return "storage_unavailable";
}
@Injectable()
export class MediaCleanupService {
  private readonly logger = new Logger(MediaCleanupService.name);
  private running = false;
  constructor(private readonly repository: MediaCleanupRepository) {}
  /** Called by the worker lifecycle poller; never overlaps its own bounded batch. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const claims = await this.repository.claim();
      for (const claim of claims) {
        let code: MediaCleanupErrorCode | "missing" | undefined;
        try {
          await unlinkMediaCleanupFile(env.MEDIA_STORAGE_DIR, claim);
        } catch (error) {
          code = failureCode(error);
        }
        if (!code || code === "missing") await this.repository.complete(claim);
        else {
          await this.repository.fail(claim, code);
          this.logger.warn(`Media cleanup retry: ${code}`);
        }
      }
      await this.repository.prune();
    } finally {
      this.running = false;
    }
  }
}
