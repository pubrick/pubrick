import { createWriteStream, type WriteStream } from "node:fs";
import { chmod, mkdtemp, rm, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { PayloadTooLargeException, ServiceUnavailableException } from "@nestjs/common";
export const EXPORT_STAGE_PREFIX = "pubrick-workspace-export-";
export const EXPORT_MAX_ARCHIVE_BYTES = 1024 ** 3;
const SPACE_CHECK_BYTES = 64 * 1024 ** 2;
const SPACE_HEADROOM_BYTES = 256n * 1024n ** 2n;
export interface ExportStage {
  directory: string;
  filename: string;
  limit: () => Transform;
  writer: () => WriteStream;
}
type StageOptions = {
  root?: string;
  /** Tests may lower the fixed technical cap, never increase it. */
  maxBytes?: number;
  freeBytes?: () => Promise<bigint>;
};
/** Private owned lifecycle. Call after gzip so the bound measures real disk bytes. */
export async function withExportStage<T>(
  consume: (stage: ExportStage) => Promise<T>,
  options: StageOptions = {},
): Promise<T> {
  const maximum = options.maxBytes ?? EXPORT_MAX_ARCHIVE_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > EXPORT_MAX_ARCHIVE_BYTES)
    throw new Error("Invalid export archive bound.");
  const directory = await mkdtemp(join(options.root ?? tmpdir(), EXPORT_STAGE_PREFIX));
  const filename = join(directory, "workspace.tar.gz");
  try {
    await chmod(directory, 0o700);
    const available =
      options.freeBytes ??
      (async () => {
        const info = await statfs(directory, { bigint: true });
        return info.bavail * info.bsize;
      });
    return await consume({
      directory,
      filename,
      limit: () => {
        let written = 0;
        let nextSpaceCheck = 0;
        return new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            written += chunk.length;
            if (written > maximum) {
              callback(
                new PayloadTooLargeException("Workspace export exceeds the 1 GiB archive limit."),
              );
              return;
            }
            if (written < nextSpaceCheck) {
              callback(null, chunk);
              return;
            }
            nextSpaceCheck = written + SPACE_CHECK_BYTES;
            void available().then(
              (free) => {
                if (free < SPACE_HEADROOM_BYTES)
                  callback(
                    new ServiceUnavailableException(
                      "Temporary export storage is full. Try again later.",
                    ),
                  );
                else callback(null, chunk);
              },
              () =>
                callback(
                  new ServiceUnavailableException("Temporary export storage is unavailable."),
                ),
            );
          },
        });
      },
      writer: () => createWriteStream(filename, { flags: "wx", mode: 0o600 }),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
