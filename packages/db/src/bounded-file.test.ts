import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBoundedFile } from "./bounded-file.js";

describe("bounded regular storage files", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "pubrick-bounded-file-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("reads the exact regular-file bytes within the allocation bound", async () => {
    const file = path.join(directory, "asset.jpg");
    await writeFile(file, Buffer.from([0, 128, 255]));
    expect(await readBoundedFile(file, 3, 3)).toEqual(Buffer.from([0, 128, 255]));
  });

  it.each([0, -1, 1.5, 4])("refuses invalid or excessive expected length %s", async (length) => {
    await expect(readBoundedFile(path.join(directory, "absent.jpg"), length, 3)).rejects.toThrow(
      "Stored file is unavailable",
    );
  });

  it.each([2, 4])("refuses a file whose length differs from expected %s bytes", async (length) => {
    const file = path.join(directory, "asset.jpg");
    await writeFile(file, Buffer.from([0, 128, 255]));
    await expect(readBoundedFile(file, length, 4)).rejects.toThrow("Stored file is unavailable");
  });

  it("does not follow a storage symlink or treat a directory as an asset", async () => {
    const file = path.join(directory, "asset.jpg");
    const link = path.join(directory, "link.jpg");
    await writeFile(file, Buffer.from([0, 128, 255]));
    await symlink(file, link);
    await expect(readBoundedFile(link, 3, 3)).rejects.toThrow();
    await expect(readBoundedFile(directory, 3, 3)).rejects.toThrow("Stored file is unavailable");
  });

  it("promptly refuses a FIFO without a writer and releases a blocked mutant during cleanup", async () => {
    const fifo = path.join(directory, "asset.jpg");
    execFileSync("mkfifo", [fifo], { timeout: 1000 });
    const reading = readBoundedFile(fifo, 3, 3).then(
      () => "read",
      (error: unknown) => {
        if (!(error instanceof Error) || error.message !== "Stored file is unavailable")
          throw error;
        return "refused";
      },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("blocked"), 500);
      });
      expect(await Promise.race([reading, deadline])).toBe("refused");
    } finally {
      if (timer) clearTimeout(timer);
      // If O_NONBLOCK is removed, opening a writer releases the blocked reader.
      // Hold it until fstat has refused the FIFO so this regression never leaks a handle.
      let writer: Awaited<ReturnType<typeof open>> | undefined;
      try {
        writer = await open(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
      } catch (error) {
        expect(error).toHaveProperty("code", "ENXIO");
      }
      try {
        await reading;
      } finally {
        await writer?.close();
      }
    }
  });
});
