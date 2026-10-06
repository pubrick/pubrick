import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** Server storage readers supply a UUID-derived path; never follow links or allocate from an untrusted file length. */
export async function readBoundedFile(
  filePath: string,
  expectedBytes: number,
  maximumBytes: number,
): Promise<Buffer> {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > maximumBytes)
    throw new Error("Stored file is unavailable");
  const file = await open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size !== expectedBytes)
      throw new Error("Stored file is unavailable");
    const bytes = Buffer.alloc(expectedBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== expectedBytes || (await file.stat()).size !== expectedBytes)
      throw new Error("Stored file is unavailable");
    return bytes.subarray(0, expectedBytes);
  } finally {
    await file.close();
  }
}
