#!/usr/bin/env node
// Native Compose, pg_dump/pg_restore and tar own their formats; Node owns the
// orchestration and integrity contract. No dotenv/archive parser is duplicated.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const writers = ["web", "api", "worker"];
const files = ["database.dump", "media.tar", "environment.env", "compose.json"];
function hash(file) {
  const digest = createHash("sha256");
  const descriptor = openSync(file, "r");
  const chunk = Buffer.alloc(1024 * 1024);
  try {
    for (;;) {
      const length = readSync(descriptor, chunk);
      if (length === 0) break;
      digest.update(chunk.subarray(0, length));
    }
  } finally {
    closeSync(descriptor);
  }
  return digest.digest("hex");
}
function fail(message) {
  throw new Error(message);
}
export function validateSnapshot(directory) {
  const manifest = JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8"));
  if (
    manifest.version !== 1 ||
    manifest.complete !== true ||
    !manifest.sha256 ||
    Object.keys(manifest.sha256).sort().join() !== [...files].sort().join()
  )
    fail("Incomplete or unsupported snapshot.");
  for (const name of files) {
    const file = path.join(directory, name);
    if (!lstatSync(file).isFile() || hash(file) !== manifest.sha256[name])
      fail(`Snapshot checksum failed: ${name}`);
  }
  return manifest;
}
export function recover({
  action,
  project,
  directory,
  cwd = process.cwd(),
  execute = spawnSync,
  composeFiles = [],
}) {
  if (
    !["backup", "restore"].includes(action) ||
    !/^[a-z0-9][a-z0-9_-]*$/.test(project ?? "") ||
    !directory
  )
    fail(
      "Usage: node scripts/recovery.mjs backup|restore --project NAME --directory ABSOLUTE_PATH",
    );
  const destination = path.resolve(directory);
  const environment = path.join(cwd, ".env");
  if (!existsSync(environment)) fail("A local .env is required.");
  if (
    !Array.isArray(composeFiles) ||
    composeFiles.some((file) => typeof file !== "string" || !file)
  )
    fail("Invalid Compose file list.");
  const compose = [
    "compose",
    "--project-name",
    project,
    "--env-file",
    environment,
    ...composeFiles.flatMap((file) => ["--file", file]),
  ];
  const relativeDestination = path.relative(cwd, destination);
  if (
    action === "backup" &&
    (!relativeDestination ||
      (!relativeDestination.startsWith(`..${path.sep}`) &&
        relativeDestination !== ".." &&
        !path.isAbsolute(relativeDestination)))
  )
    fail("Store plaintext recovery snapshots outside the checkout.");
  const command = (args, options = {}) => {
    const result = execute("docker", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
      ...options,
    });
    // Docker diagnostics may contain interpolated secrets. Never forward stderr.
    if (result.status !== 0)
      fail(
        `Docker operation failed (${args[0]} ${args[1] ?? ""}); inspect the selected project locally.`,
      );
    return result.stdout ?? "";
  };
  const dc = (args, options) => command([...compose, ...args], options);
  const config = JSON.parse(dc(["config", "--format", "json"]));
  const db = config.services.postgres?.environment;
  const media = config.services.api?.volumes?.find((entry) => entry.target === "/data/media");
  const volume = config.volumes?.[media?.source]?.name;
  const image = config.services.postgres?.image;
  if (!db?.POSTGRES_USER || !db?.POSTGRES_DB || !volume || media.type !== "volume" || !image)
    fail("Recovery supports the standard Compose Postgres and named media volume only.");
  command(["volume", "inspect", volume]);
  const lock = path.join(cwd, `.recovery-${project}.lock`);
  mkdirSync(lock, { mode: 0o700 });
  let restart = [];
  let staged;
  const pg = (args, options) => dc(["exec", "-T", "postgres", ...args], options);
  const tar = (args, options, writable = false) =>
    command(
      [
        "run",
        "--rm",
        "--pull=never",
        "-i",
        "--network",
        "none",
        "--mount",
        `type=volume,src=${volume},dst=/media${writable ? "" : ",readonly"}`,
        "--entrypoint",
        "tar",
        image,
        ...args,
      ],
      options,
    );
  const output = (file, operation) => {
    const descriptor = openSync(file, "wx", 0o600);
    try {
      operation({ stdio: ["ignore", descriptor, "pipe"], encoding: undefined });
    } finally {
      closeSync(descriptor);
    }
  };
  const input = (file, operation) => {
    const descriptor = openSync(file, "r");
    try {
      return operation({ stdio: [descriptor, "pipe", "pipe"] });
    } finally {
      closeSync(descriptor);
    }
  };
  const validateMedia = (archive) => {
    const paths = input(archive, (options) => tar(["-tf", "-"], options))
      .trim()
      .split("\n");
    const types = input(archive, (options) => tar(["-tvf", "-"], options))
      .trim()
      .split("\n");
    if (
      paths.some((name) => name.startsWith("/") || name.split("/").includes("..")) ||
      types.some((line) => !["d", "-"].includes(line[0]))
    )
      fail("Unsafe media archive: only relative regular files and directories are supported.");
  };
  try {
    const running = dc(["ps", "--status", "running", "--services"]).trim().split(/\s+/);
    if (!running.includes("postgres"))
      fail("Start only the selected project Postgres before recovery.");
    if (action === "backup") {
      // A changed .env must not archive a new key alongside a database still
      // written by containers using the old key. Compare effective runtime keys
      // and mounts before quiescing instead of trusting configuration alone.
      for (const service of ["api", "worker"]) {
        const id = dc(["ps", "--all", "--quiet", service]).trim();
        if (!id) continue;
        const [container] = JSON.parse(command(["inspect", id]));
        const actualEnvironment = Object.fromEntries(
          (container.Config?.Env ?? []).map((entry) => {
            const separator = entry.indexOf("=");
            return [entry.slice(0, separator), entry.slice(separator + 1)];
          }),
        );
        for (const key of ["APP_ENCRYPTION_KEY", "BETTER_AUTH_SECRET"]) {
          const expected = config.services[service]?.environment?.[key];
          if (expected && actualEnvironment[key] !== expected)
            fail(
              `Running ${service} configuration differs from .env; reconcile keys before backup.`,
            );
        }
        const actualMedia = container.Mounts?.find((mount) => mount.Destination === "/data/media");
        if (actualMedia && actualMedia.Name !== volume)
          fail("Runtime media volume differs from Compose configuration.");
      }
      if (existsSync(destination)) fail("Backup destination already exists.");
      staged = `${destination}.partial-${process.pid}`;
      mkdirSync(staged, { mode: 0o700 });
      restart = writers.filter((service) => running.includes(service));
      if (restart.length) dc(["stop", "--timeout", "120", ...restart]);
      // Compose config is resolved before and again after quiescing. Refuse an
      // operator changing effective configuration during the snapshot.
      const current = JSON.parse(dc(["config", "--format", "json"]));
      if (JSON.stringify(config) !== JSON.stringify(current))
        fail("Compose configuration changed during backup.");
      const environmentBytes = readFileSync(environment);
      writeFileSync(path.join(staged, "environment.env"), environmentBytes, { mode: 0o600 });
      chmodSync(path.join(staged, "environment.env"), 0o600);
      writeFileSync(path.join(staged, "compose.json"), JSON.stringify(config, null, 2), {
        mode: 0o600,
      });
      output(path.join(staged, "database.dump"), (options) =>
        pg(
          [
            "pg_dump",
            "-U",
            db.POSTGRES_USER,
            "-d",
            db.POSTGRES_DB,
            "--format=custom",
            "--no-owner",
            "--no-acl",
          ],
          options,
        ),
      );
      output(path.join(staged, "media.tar"), (options) =>
        tar(["-C", "/media", "-cf", "-", "."], options),
      );
      validateMedia(path.join(staged, "media.tar"));
      if (
        !environmentBytes.equals(readFileSync(environment)) ||
        JSON.stringify(config) !== JSON.stringify(JSON.parse(dc(["config", "--format", "json"])))
      )
        fail("Configuration changed during backup.");
      writeFileSync(
        path.join(staged, "manifest.json"),
        JSON.stringify(
          {
            version: 1,
            complete: true,
            createdAt: new Date().toISOString(),
            project,
            sha256: Object.fromEntries(files.map((name) => [name, hash(path.join(staged, name))])),
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      renameSync(staged, destination);
      staged = undefined;
    } else {
      validateSnapshot(destination);
      if (writers.some((service) => running.includes(service)))
        fail("Restore refuses running web, API or worker services. Stop them first.");
      const original = JSON.parse(readFileSync(path.join(destination, "compose.json"), "utf8"));
      for (const key of ["APP_ENCRYPTION_KEY", "BETTER_AUTH_SECRET"]) {
        if (
          !original.services?.api?.environment?.[key] ||
          original.services.api.environment[key] !== config.services.api.environment[key]
        )
          fail(`Target ${key} must match the snapshot before restoring.`);
      }
      if (
        config.services.worker?.environment?.APP_ENCRYPTION_KEY &&
        config.services.worker.environment.APP_ENCRYPTION_KEY !==
          config.services.api.environment.APP_ENCRYPTION_KEY
      )
        fail("Target API and worker encryption key rings must match.");
      const count = pg([
        "psql",
        "-U",
        db.POSTGRES_USER,
        "-d",
        db.POSTGRES_DB,
        "-At",
        "-c",
        "SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_%') + (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_%') + (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_%') + (SELECT count(*) FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema','public') AND nspname NOT LIKE 'pg_%');",
      ]).trim();
      if (count !== "0") fail("Restore requires a fresh empty database.");
      // Listing emptiness is reliable across tar block padding implementations.
      const existing = command([
        "run",
        "--rm",
        "--pull=never",
        "-i",
        "--network",
        "none",
        "--mount",
        `type=volume,src=${volume},dst=/media,readonly`,
        "--entrypoint",
        "find",
        image,
        "/media",
        "-mindepth",
        "1",
        "-print",
        "-quit",
      ]).trim();
      if (existing) fail("Restore requires an empty media volume.");
      const archive = path.join(destination, "media.tar");
      validateMedia(archive);
      const dump = path.join(destination, "database.dump");
      input(dump, (options) => pg(["pg_restore", "--list"], options));
      // Media is restored first: a failed transactional DB restore leaves no
      // usable database; the operator removes the disposable target and retries.
      input(archive, (options) =>
        tar(
          ["-C", "/media", "-xf", "-", "--no-same-owner", "--no-same-permissions"],
          options,
          true,
        ),
      );
      input(dump, (options) =>
        pg(
          [
            "pg_restore",
            "-U",
            db.POSTGRES_USER,
            "-d",
            db.POSTGRES_DB,
            "--single-transaction",
            "--exit-on-error",
            "--no-owner",
            "--no-acl",
          ],
          options,
        ),
      );
    }
  } finally {
    try {
      if (staged) rmSync(staged, { recursive: true, force: true });
    } finally {
      try {
        if (restart.length) dc(["start", ...restart]);
      } finally {
        rmSync(lock, { recursive: true, force: true });
      }
    }
  }
  return action === "backup"
    ? "Backup complete. Previously running services restarted."
    : "Restore complete. Web, API and worker remain stopped. Review queued publications before explicitly resuming the worker.";
}
export function parseArguments(args) {
  const [action, ...flags] = args;
  const options = { action, composeFiles: [] };
  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index];
    const value = flags[index + 1];
    if (
      !["--project", "--directory", "--compose-file"].includes(flag) ||
      !value ||
      value.startsWith("--")
    )
      fail("Unknown or incomplete recovery option.");
    if (flag === "--compose-file") options.composeFiles.push(value);
    else {
      const key = flag.slice(2);
      if (options[key]) fail(`Duplicate recovery option: ${flag}`);
      options[key] = value;
    }
  }
  return options;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(recover(parseArguments(process.argv.slice(2))));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
