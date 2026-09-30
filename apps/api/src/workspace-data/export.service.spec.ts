import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { gunzipSync } from "node:zlib";
import { extract } from "tar-stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExportSnapshot, WorkspaceExportRepository } from "./export.repository";

vi.mock("../db", () => ({ pool: {} }));
vi.mock("../env", () => ({ env: { DATABASE_URL: "postgres://unused-export-fixture" } }));

const { storage } = vi.hoisted(() => ({ storage: { directory: "" } }));
vi.mock("../media/media.repository", () => ({
  mediaPath: (id: string, kind: string) =>
    `${storage.directory}/${id}.${kind === "image" ? "jpg" : "mp4"}`,
}));

import { WorkspaceExportService } from "./export.service";

async function* rows(values: Record<string, unknown>[]) {
  yield* values;
}
function snapshot(data: Record<string, Record<string, unknown>[]> = {}): ExportSnapshot {
  return {
    signal: new AbortController().signal,
    organization: {
      id: "tenant-one",
      name: "Workspace",
      slug: "workspace",
      createdAt: new Date(0),
    },
    capturedAt: new Date(0),
    members: () => rows([{ userId: "owner", role: "owner", createdAt: new Date(0) }]),
    rows: (policy) => rows(data[policy.key] ?? []),
  };
}
function repository(value: ExportSnapshot): WorkspaceExportRepository {
  // The archive unit tier replaces database ownership with the supplied snapshot.
  return {
    withSnapshot: async (_orgId, _userId, _signal, consume) => consume(value),
  } as WorkspaceExportRepository;
}
function capture() {
  const bytes: Buffer[] = [];
  const writable = new Writable({
    write(chunk: Buffer, _encoding, done) {
      bytes.push(Buffer.from(chunk));
      done();
    },
  });
  return { writable, content: () => Buffer.concat(bytes) };
}
async function unpack(content: Buffer): Promise<Map<string, Buffer>> {
  const archive = extract();
  const files = new Map<string, Buffer>();
  archive.end(gunzipSync(content));
  for await (const stream of archive) {
    const bytes: Buffer[] = [];
    for await (const chunk of stream) {
      if (!(chunk instanceof Uint8Array)) throw new Error("Invalid archive byte fixture");
      bytes.push(Buffer.from(chunk));
    }
    files.set(stream.header.name, Buffer.concat(bytes));
  }
  return files;
}

afterEach(async () => {
  if (storage.directory) await rm(storage.directory, { recursive: true, force: true });
  storage.directory = "";
});

describe("portable workspace archive", () => {
  it("retains Unicode content, original media bytes, checksum and complete manifest", async () => {
    storage.directory = await mkdtemp(path.join(tmpdir(), "pubrick-export-"));
    const id = randomUUID();
    const image = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    await writeFile(path.join(storage.directory, `${id}.jpg`), image);
    const sink = capture();
    const service = new WorkspaceExportService(
      repository(
        snapshot({
          contentItems: [
            {
              id: randomUUID(),
              orgId: "tenant-one",
              body: "Olá — Привет",
              richBody: { type: "doc" },
            },
          ],
          mediaAssets: [{ id, orgId: "tenant-one", kind: "image", byteSize: image.length }],
        }),
      ),
    );
    await service.stream("tenant-one", "owner", new AbortController().signal, () => sink.writable);
    const files = await unpack(sink.content());
    expect(files.get(`media/${id}.jpg`)).toEqual(image);
    expect(files.get("data/contentItems/000001.ndjson")?.toString()).toContain("Olá — Привет");
    expect(JSON.parse(files.get(`media-checksums/${id}.json`)?.toString() ?? "null")).toMatchObject(
      {
        byteSize: image.length,
        sha256: createHash("sha256").update(image).digest("hex"),
      },
    );
    expect(JSON.parse(files.get("manifest.json")?.toString() ?? "null")).toMatchObject({
      complete: true,
      memberCount: 1,
      mediaCount: 1,
      rowCounts: { contentItems: 1 },
    });
  });

  it("starts the download only after the snapshot has committed", async () => {
    let committed = false;
    const value = snapshot();
    const staged = {
      withSnapshot: async (_orgId, _userId, _signal, consume) => {
        const result = await consume(value);
        committed = true;
        return result;
      },
    } as WorkspaceExportRepository;
    const sink = capture();
    await new WorkspaceExportService(staged).stream(
      "tenant-one",
      "owner",
      new AbortController().signal,
      () => {
        expect(committed).toBe(true);
        return sink.writable;
      },
    );
    expect((await unpack(sink.content())).has("manifest.json")).toBe(true);
  });

  it("does not start a download when snapshot commit fails", async () => {
    const value = snapshot();
    const failing = {
      withSnapshot: async (_orgId, _userId, _signal, consume) => {
        await consume(value);
        throw new Error("Snapshot commit failed");
      },
    } as WorkspaceExportRepository;
    const start = vi.fn(() => capture().writable);
    await expect(
      new WorkspaceExportService(failing).stream(
        "tenant-one",
        "owner",
        new AbortController().signal,
        start,
      ),
    ).rejects.toThrow("Snapshot commit failed");
    expect(start).not.toHaveBeenCalled();
  });

  it("splits large data into readable NDJSON parts and retains every row", async () => {
    const values = Array.from({ length: 40 }, (_value, index) => ({
      index,
      body: "a".repeat(100_000),
    }));
    const sink = capture();
    await new WorkspaceExportService(repository(snapshot({ contentItems: values }))).stream(
      "tenant-one",
      "owner",
      new AbortController().signal,
      () => sink.writable,
    );
    const files = await unpack(sink.content());
    const parts = [...files.entries()].filter(([name]) => name.startsWith("data/contentItems/"));
    expect(parts.length).toBeGreaterThan(1);
    const exported = parts.flatMap(([, bytes]) =>
      bytes
        .toString()
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    );
    expect(exported).toEqual(values);
  });

  it("refuses replaced symbolic-link media and never finalizes a successful archive", async () => {
    storage.directory = await mkdtemp(path.join(tmpdir(), "pubrick-export-"));
    const id = randomUUID();
    await writeFile(path.join(storage.directory, "unrelated.txt"), "unrelated secret");
    await symlink(
      path.join(storage.directory, "unrelated.txt"),
      path.join(storage.directory, `${id}.jpg`),
    );
    const sink = capture();
    await expect(
      new WorkspaceExportService(
        repository(
          snapshot({
            mediaAssets: [{ id, kind: "image", byteSize: 16 }],
          }),
        ),
      ).stream("tenant-one", "owner", new AbortController().signal, () => sink.writable),
    ).rejects.toThrow();
    expect(sink.content().includes(Buffer.from("unrelated secret"))).toBe(false);
  });

  it("does not open an output before authoritative authorization", async () => {
    const start = vi.fn();
    const repo = {
      withSnapshot: async () => {
        throw new Error("Forbidden");
      },
    } as unknown as WorkspaceExportRepository;
    await expect(
      new WorkspaceExportService(repo).stream(
        "tenant-one",
        "member",
        new AbortController().signal,
        start,
      ),
    ).rejects.toThrow("Forbidden");
    expect(start).not.toHaveBeenCalled();
  });
});
