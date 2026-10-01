import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const services = ["api", "worker", "web"];
const fail = (reason) => {
  throw new Error(`Invalid release assets: ${reason}`);
};

// Exact release-asset semantics belong to this repository; no dotenv evaluation
// is needed or allowed. Node's maintained parseArgs handles the CLI boundary.
export function validateReleaseAssets({ manifest, env, tag, sha, repository }) {
  if (
    typeof tag !== "string" ||
    !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[a-z0-9]+(?:[.-][a-z0-9]+)*)?$/.test(tag)
  )
    fail("expected version is malformed");
  if (typeof sha !== "string" || !/^[a-f0-9]{40}$/.test(sha))
    fail("expected source SHA is malformed");
  if (
    typeof repository !== "string" ||
    !/^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/.test(repository)
  )
    fail("expected repository is malformed");
  if (!Array.isArray(manifest) || manifest.length !== 3)
    fail("manifest must contain exactly three services");
  const images = new Map();
  for (const entry of manifest) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.keys(entry).sort().join(",") !== "image,platforms,service,sourceSha,tag"
    )
      fail("unexpected manifest fields");
    if (!services.includes(entry.service) || images.has(entry.service))
      fail("missing or duplicate service");
    if (entry.tag !== tag || entry.sourceSha !== sha)
      fail("version or source SHA differs from the expected release");
    const prefix = `ghcr.io/${repository}-${entry.service}@sha256:`;
    if (
      typeof entry.image !== "string" ||
      !entry.image.startsWith(prefix) ||
      !/^[a-f0-9]{64}$/.test(entry.image.slice(prefix.length))
    )
      fail("image must name the expected service repository and immutable digest");
    if (
      !Array.isArray(entry.platforms) ||
      entry.platforms.length !== 2 ||
      !entry.platforms.every((platform) => typeof platform === "string") ||
      [...entry.platforms].sort().join(",") !== "linux/amd64,linux/arm64"
    )
      fail("platforms must be AMD64 and ARM64 exactly once");
    images.set(entry.service, entry.image);
  }
  if (typeof env !== "string") fail("image assignments must be text");
  const seen = new Set();
  for (const line of env.split(/\r?\n/)) {
    if (line === "") continue;
    const match = /^PUBRICK_(API|WORKER|WEB)_IMAGE=(.+)$/.exec(line);
    if (!match) fail("unexpected image assignment");
    const service = match[1].toLowerCase();
    if (seen.has(service) || match[2] !== images.get(service))
      fail("duplicate assignment or digest differs from the manifest");
    seen.add(service);
  }
  if (seen.size !== 3) fail("missing image assignment");
  return { tag, sha, services: [...services] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values } = parseArgs({
      options: {
        tag: { type: "string" },
        "source-sha": { type: "string" },
        repository: { type: "string", default: "pubrick/pubrick" },
        manifest: { type: "string", default: "release-manifest.json" },
        images: { type: "string", default: "release-images.env" },
      },
    });
    validateReleaseAssets({
      tag: values.tag,
      sha: values["source-sha"],
      repository: values.repository,
      manifest: JSON.parse(readFileSync(values.manifest, "utf8")),
      env: readFileSync(values.images, "utf8"),
    });
    console.log("Release assets match the expected version, source and three image digests.");
  } catch {
    console.error(
      "Release asset validation failed. Check the downloaded files and explicit --tag/--source-sha arguments; do not install this asset set.",
    );
    process.exitCode = 1;
  }
}
