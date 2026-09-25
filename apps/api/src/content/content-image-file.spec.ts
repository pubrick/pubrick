import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeCropFile } from "./content-image-file";

describe("owned crop files", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("removes a partial JPEG when the writer fails after creating it", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pubrick-crop-file-"));
    directories.push(directory);
    const target = path.join(directory, "partial.jpg");
    const failedWrite: typeof writeFile = async (file, _bytes, options) => {
      await writeFile(file, Buffer.from("partial"), options);
      throw new Error("disk full during write");
    };
    await expect(writeCropFile(target, Buffer.from("complete"), failedWrite)).rejects.toThrow(
      "disk full during write",
    );
    await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never deletes a file it did not create", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pubrick-crop-file-"));
    directories.push(directory);
    const target = path.join(directory, "existing.jpg");
    await writeFile(target, Buffer.from("existing"));
    await expect(writeCropFile(target, Buffer.from("new"))).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(await readFile(target)).toEqual(Buffer.from("existing"));
  });
});
