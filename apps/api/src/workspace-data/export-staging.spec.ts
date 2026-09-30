import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { afterEach, expect, it } from "vitest";
import { EXPORT_MAX_ARCHIVE_BYTES, withExportStage } from "./export-staging";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function root() {
  const directory = await mkdtemp(join(tmpdir(), "pubrick-staging-test-"));
  directories.push(directory);
  return directory;
}
it("bounds compressed bytes with413 and removes partial plaintext artifacts", async () => {
  const directory = await root();
  expect(EXPORT_MAX_ARCHIVE_BYTES).toBe(1024 ** 3);
  let filename = "";
  await expect(
    withExportStage(
      async (stage) => {
        filename = stage.filename;
        await pipeline(
          Readable.from([Buffer.alloc(8), Buffer.alloc(9)]),
          stage.limit(),
          stage.writer(),
        );
      },
      { root: directory, maxBytes: 16, freeBytes: async () => 1024n ** 3n },
    ),
  ).rejects.toMatchObject({ status: 413 });
  expect(await readdir(directory)).toEqual([]);
  await expect(stat(filename)).rejects.toMatchObject({ code: "ENOENT" });
});
it("creates private stages and cleans success and cancellation", async () => {
  const directory = await root();
  const controller = new AbortController();
  await withExportStage(
    async (stage) => {
      expect((await stat(stage.directory)).mode & 0o777).toBe(0o700);
      await pipeline(
        Readable.from([Buffer.from("private content")]),
        stage.limit(),
        stage.writer(),
      );
      expect((await stat(stage.filename)).mode & 0o777).toBe(0o600);
    },
    { root: directory, freeBytes: async () => 1024n ** 3n },
  );
  expect(await readdir(directory)).toEqual([]);
  await expect(
    withExportStage(
      async () => {
        controller.abort();
        controller.signal.throwIfAborted();
      },
      { root: directory },
    ),
  ).rejects.toThrow();
  expect(await readdir(directory)).toEqual([]);
});
it("refuses insufficient stage disk headroom before writing", async () => {
  const directory = await root();
  await expect(
    withExportStage(
      async (stage) => {
        await pipeline(Readable.from([Buffer.from("private")]), stage.limit(), stage.writer());
      },
      { root: directory, freeBytes: async () => 0n },
    ),
  ).rejects.toMatchObject({ status: 503 });
  expect(await readdir(directory)).toEqual([]);
});
