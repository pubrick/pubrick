import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function validateRelease({ tag, sha, cwd = process.cwd() }) {
  if (
    !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[a-z0-9]+(?:[.-][a-z0-9]+)*)?$/.test(tag ?? "")
  ) {
    throw new Error(
      "Release tag must be vMAJOR.MINOR.PATCH, optionally with a lowercase prerelease suffix",
    );
  }
  if (!/^[a-f0-9]{40}$/.test(sha ?? ""))
    throw new Error("Source SHA must be a full lowercase commit SHA");
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (git("rev-parse", `${sha}^{commit}`) !== sha) throw new Error("Source SHA is not a commit");
  if (git("rev-parse", `refs/tags/${tag}^{commit}`) !== sha)
    throw new Error("Tag does not point to the requested source SHA");
  git("merge-base", "--is-ancestor", sha, "origin/main");
  return { tag, sha };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: manual release CLI, never a cached Turbo task
    validateRelease({ tag: process.env.RELEASE_TAG, sha: process.env.RELEASE_SHA });
    console.log("Release tag and source SHA verified against origin/main");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
