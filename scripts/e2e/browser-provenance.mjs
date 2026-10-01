import { spawnSync } from "node:child_process";

// Match the reviewed PostgreSQL image used by CI; never certify a moving tag.
export const BROWSER_POSTGRES_IMAGE =
  "pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b";

export function readBrowserSource(cwd = process.cwd()) {
  const revision = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
  });
  const source = revision.stdout?.trim();
  if (revision.error || revision.status !== 0 || !/^[a-f0-9]{40}$/.test(source ?? ""))
    throw new Error("Cannot verify browser source commit; check Git and your developer tools");
  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (status.error || status.status !== 0)
    throw new Error("Cannot verify browser source working tree");
  if (status.stdout.trim())
    throw new Error("Commit browser source changes before running acceptance");
  return source;
}

export function verifyBrowserSource(source, cwd = process.cwd()) {
  if (readBrowserSource(cwd) !== source)
    throw new Error("Browser source commit changed during acceptance");
}
