import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { Transform, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import {
  HttpException,
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
  ServiceUnavailableException,
} from "@nestjs/common";
import { getTableColumns } from "drizzle-orm";
import pLimit from "p-limit";
import { type Pack, pack } from "tar-stream";
import { z } from "zod";
import { mediaPath } from "../media/media.repository";
import { WorkspaceExportRepository } from "./export.repository";
import { WORKSPACE_EXPORT_OMISSIONS, WORKSPACE_EXPORT_TABLES } from "./export-policy";
import { withExportStage } from "./export-staging";
import { createExportStageJanitor } from "./export-staging-retention";

const mediaRowSchema = z.object({
  id: z.uuid(),
  kind: z.enum(["image", "video"]),
  byteSize: z
    .number()
    .int()
    .positive()
    .max(20 * 1024 * 1024),
});
const CHUNK_BYTES = 1024 * 1024;

async function entry(archive: Pack, name: string, content: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    archive.entry({ name, size: content.length, mode: 0o600 }, content, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

async function records(
  archive: Pack,
  name: string,
  rows: AsyncIterable<Record<string, unknown>>,
): Promise<number> {
  let chunk: string[] = [];
  let bytes = 0;
  let part = 0;
  let count = 0;
  const flush = async () => {
    await entry(
      archive,
      `${name}/${String(++part).padStart(6, "0")}.ndjson`,
      Buffer.from(chunk.join("")),
    );
    chunk = [];
    bytes = 0;
  };
  for await (const row of rows) {
    const line = `${JSON.stringify(row)}\n`;
    chunk.push(line);
    bytes += Buffer.byteLength(line);
    count++;
    if (bytes >= CHUNK_BYTES) await flush();
  }
  if (chunk.length || part === 0) await flush();
  return count;
}

@Injectable()
export class WorkspaceExportService implements OnModuleInit, OnModuleDestroy {
  private readonly janitor = createExportStageJanitor();
  async onModuleInit() {
    await this.janitor.start();
  }
  onModuleDestroy() {
    this.janitor.stop();
  }
  // Bound connection and compression usage per API process. There is no
  // unbounded waiting list when several owners request large exports together.
  private readonly admitted = pLimit(2);
  constructor(
    @Inject(WorkspaceExportRepository)
    private readonly repository: Pick<WorkspaceExportRepository, "withSnapshot">,
  ) {}

  async stream(
    orgId: string,
    userId: string,
    signal: AbortSignal,
    start: () => Writable,
  ): Promise<void> {
    if (this.admitted.activeCount + this.admitted.pendingCount >= 2)
      throw new ServiceUnavailableException("Data export is busy. Try again shortly.");
    await this.admitted(() =>
      withExportStage(async (stage) => {
        await this.buildArchive(
          orgId,
          userId,
          AbortSignal.any([signal, AbortSignal.timeout(5 * 60 * 1000)]),
          stage.writer,
          stage.limit(),
        );
        signal.throwIfAborted();
        // Release the database snapshot before waiting on a slow download.
        await pipeline(createReadStream(stage.filename), start(), {
          signal: AbortSignal.any([signal, AbortSignal.timeout(45 * 60 * 1000)]),
        });
      }),
    );
  }

  private async buildArchive(
    orgId: string,
    userId: string,
    bounded: AbortSignal,
    start: () => Writable,
    compressedLimit: Transform,
  ): Promise<void> {
    let archive: Pack | undefined;
    let delivery: Promise<void> | undefined;
    try {
      await this.repository.withSnapshot(orgId, userId, bounded, async (snapshot) => {
        archive = pack();
        const output = start();
        delivery = pipeline(archive, createGzip(), compressedLimit, output, {
          signal: snapshot.signal,
        });
        // Observe failure immediately while the producer is still querying.
        // Awaiting again below preserves the failure for the caller.
        void delivery.catch(() => undefined);
        await entry(archive, "workspace.json", Buffer.from(JSON.stringify(snapshot.organization)));
        const counts: Record<string, number> = {};
        const excludedFields: Record<string, string[]> = {};
        const memberCount = await records(archive, "data/members", snapshot.members());
        let mediaCount = 0;
        for (const policy of WORKSPACE_EXPORT_TABLES) {
          snapshot.signal.throwIfAborted();
          const columns = Object.keys(getTableColumns(policy.table));
          excludedFields[policy.key] = columns.filter(
            (column) => !(policy.fields as readonly string[]).includes(column),
          );
          counts[policy.key] = await records(archive, `data/${policy.key}`, snapshot.rows(policy));
        }
        const media = WORKSPACE_EXPORT_TABLES.find((policy) => policy.key === "mediaAssets");
        if (!media) throw new Error("Workspace export media policy is missing.");
        for await (const raw of snapshot.rows(media)) {
          snapshot.signal.throwIfAborted();
          const asset = mediaRowSchema.parse(raw);
          const filename = `media/${asset.id}.${asset.kind === "image" ? "jpg" : "mp4"}`;
          const file = await open(
            mediaPath(asset.id, asset.kind),
            constants.O_RDONLY | constants.O_NOFOLLOW,
          );
          try {
            const stat = await file.stat();
            if (!stat.isFile() || stat.size !== asset.byteSize)
              throw new Error("Workspace media changed during export. Retry the export.");
            const hash = createHash("sha256");
            const checksum = new Transform({
              transform(chunk: Buffer, _encoding, callback) {
                hash.update(chunk);
                callback(null, chunk);
              },
            });
            await pipeline(
              file.createReadStream({ autoClose: false }),
              checksum,
              archive.entry({ name: filename, size: asset.byteSize, mode: 0o600 }),
              { signal: snapshot.signal },
            );
            await entry(
              archive,
              `media-checksums/${asset.id}.json`,
              Buffer.from(
                JSON.stringify({
                  path: filename,
                  byteSize: asset.byteSize,
                  sha256: hash.digest("hex"),
                }),
              ),
            );
            mediaCount++;
          } finally {
            await file.close();
          }
        }
        await entry(
          archive,
          "manifest.json",
          Buffer.from(
            JSON.stringify({
              format: "pubrick-workspace-export",
              version: 1,
              capturedAt: snapshot.capturedAt,
              complete: true,
              rowCounts: counts,
              omittedTables: WORKSPACE_EXPORT_OMISSIONS,
              excludedFields,
              memberCount,
              mediaCount,
              note: "User data export, not an installation backup. Reconnect providers and regenerate derived indexes separately.",
            }),
          ),
        );
      });
      // No apparently successful download until the snapshot has committed.
      archive?.finalize();
      await delivery;
    } catch (error) {
      archive?.destroy(new Error("Workspace export did not finish."));
      const deliveryError = await delivery?.catch((failure: unknown) => failure);
      if (deliveryError instanceof HttpException) throw deliveryError;
      throw error;
    }
  }
}
