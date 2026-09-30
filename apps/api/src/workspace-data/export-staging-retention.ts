import { lstat, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXPORT_STAGE_PREFIX } from "./export-staging";
export const EXPORT_STALE_AFTER_MS = 2 * 60 * 60 * 1000;
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;
type RetentionOptions = { root?: string; now?: () => number; effectiveUid?: number };
/** No wildcard deletion: inspect ownership/type/mode/age before each native rm. */
export async function purgeStaleExportStages(options: RetentionOptions = {}): Promise<number> {
  const directory = options.root ?? tmpdir();
  const uid = options.effectiveUid ?? process.geteuid?.();
  if (uid === undefined) return 0;
  const now = (options.now ?? Date.now)();
  let removed = 0;
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (!item.name.startsWith(EXPORT_STAGE_PREFIX)) continue;
    const suffix = item.name.slice(EXPORT_STAGE_PREFIX.length);
    if (!/^[A-Za-z0-9]+$/.test(suffix)) continue;
    const path = join(directory, item.name);
    try {
      const info = await lstat(path);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.uid !== uid ||
        (info.mode & 0o7777) !== 0o700
      )
        continue;
      const touched = Math.max(info.mtimeMs, info.ctimeMs, info.birthtimeMs);
      if (!Number.isFinite(touched) || now - touched <= EXPORT_STALE_AFTER_MS) continue;
      await rm(path, { recursive: true, force: true });
      removed++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return removed;
}
/** Startup plus hourly maintenance. Errors remain closed; the next pass retries. */
export function createExportStageJanitor(
  options: RetentionOptions & { onError?: () => void } = {},
) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  const sweep = async () => {
    try {
      await purgeStaleExportStages(options);
    } catch {
      options.onError?.();
    }
  };
  return {
    async start() {
      if (timer || closed) return;
      await sweep();
      if (closed) return;
      timer = setInterval(() => void sweep(), MAINTENANCE_INTERVAL_MS);
      timer.unref();
    },
    stop() {
      closed = true;
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
