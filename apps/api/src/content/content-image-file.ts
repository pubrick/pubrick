import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/** `wx` owns the new path only after creation; remove partial writes on failure. */
export async function writeCropFile(
  target: string,
  bytes: Buffer,
  writer: typeof writeFile = writeFile,
): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await writer(target, bytes, { flag: "wx", mode: 0o600 });
  } catch (error) {
    // EEXIST means `wx` never owned the path. It must not remove that file.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      await unlink(target).catch(() => undefined);
    }
    throw error;
  }
}
