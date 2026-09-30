import { randomUUID } from "node:crypto";
import { AiTextSelectionChangedError } from "@pubrick/shared";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  admitAiTextCall,
  aiTextSettingsView,
  lockAiTextSelection,
  pinAiTextTarget,
  pinnedAiCredential,
  snapshotAiTextSelection,
} from "./ai-text-selection.js";
import { createDb } from "./client.js";
import { runMigrations } from "./migrate.js";
import * as schema from "./schema/index.js";

const url = process.env.TEST_DATABASE_URL;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe.skipIf(!url)("workspace text selection and lock interleavings", () => {
  let connection: ReturnType<typeof createDb>;
  const orgIds: string[] = [];
  beforeAll(async () => {
    await runMigrations(url as string);
    connection = createDb(url as string);
  }, 60_000);
  afterAll(async () => {
    if (!connection) return;
    for (const orgId of orgIds)
      await connection.db.delete(schema.organization).where(eq(schema.organization.id, orgId));
    await connection.pool.end();
  });
  async function fixture() {
    const orgId = `text-${randomUUID()}`;
    orgIds.push(orgId);
    await connection.db
      .insert(schema.organization)
      .values({ id: orgId, name: "Text", slug: orgId });
    await connection.db.insert(schema.aiCredentials).values([
      {
        orgId,
        provider: "google",
        credentialsEncrypted: "opaque-google",
        defaultModel: "legacy-model",
        createdAt: new Date("2026-01-01"),
      },
      {
        orgId,
        provider: "openai",
        credentialsEncrypted: "opaque-openai",
        createdAt: new Date("2026-01-02"),
      },
    ]);
    const [brand] = await connection.db
      .insert(schema.brands)
      .values({ orgId, name: "Text" })
      .returning();
    if (!brand) throw new Error("Missing fixture brand");
    const [run] = await connection.db
      .insert(schema.pipelineRuns)
      .values({
        orgId,
        brandId: brand.id,
        input: { kind: "brief", text: "Fixture", channelIds: [] },
      })
      .returning();
    if (!run) throw new Error("Missing fixture run");
    return { orgId, runId: run.id, brandId: brand.id };
  }
  it("keeps an admitted model after default edits, refuses rotation, and never falls back on deletion", async () => {
    const { orgId } = await fixture();
    const snapshot = await connection.db.transaction(async (tx) => {
      const state = await lockAiTextSelection(orgId, tx);
      if (!state) throw new Error("Missing tenant");
      expect(aiTextSettingsView(state)).toMatchObject({
        provider: "google",
        modelId: "legacy-model",
        configured: true,
      });
      const pinned = snapshotAiTextSelection(state);
      if (!pinned) throw new Error("Missing snapshot");
      await tx
        .update(schema.aiTextSettings)
        .set({
          provider: "openai",
          model: "different-model",
          revision: state.settings.revision + 1,
        })
        .where(eq(schema.aiTextSettings.orgId, orgId));
      return pinned;
    });
    await expect(admitAiTextCall(orgId, connection.db, snapshot)).resolves.toBeUndefined();
    await connection.db.transaction(async (tx) => {
      await lockAiTextSelection(orgId, tx);
      await tx
        .update(schema.aiCredentials)
        .set({ revision: sql`${schema.aiCredentials.revision} + 1` })
        .where(eq(schema.aiCredentials.id, snapshot.credentialId));
    });
    await expect(admitAiTextCall(orgId, connection.db, snapshot)).rejects.toBeInstanceOf(
      AiTextSelectionChangedError,
    );
    await connection.db.transaction(async (tx) => {
      const state = await lockAiTextSelection(orgId, tx);
      if (!state) throw new Error("Missing tenant");
      const key = state.credentials.find((row) => row.provider === "openai");
      if (!key) throw new Error("Missing selected key");
      await tx.delete(schema.aiCredentials).where(eq(schema.aiCredentials.id, key.id));
    });
    await connection.db.transaction(async (tx) => {
      const state = await lockAiTextSelection(orgId, tx);
      if (!state) throw new Error("Missing tenant");
      expect(aiTextSettingsView(state)).toMatchObject({ provider: "openai", configured: false });
      expect(() => snapshotAiTextSelection(state)).toThrow(AiTextSelectionChangedError);
    });
  });

  it("refuses ambiguous legacy auxiliary requests and retains fresh request pins across redelivery", async () => {
    const { orgId, brandId } = await fixture();
    const [legacy] = await connection.db
      .insert(schema.topicSuggestionRequests)
      .values({ orgId, brandId, origin: "manual", attempts: 2, status: "running" })
      .returning();
    const [fresh] = await connection.db
      .insert(schema.topicSuggestionRequests)
      .values({ orgId, brandId, origin: "manual", attempts: 1, status: "running" })
      .returning();
    const [batch] = await connection.db
      .insert(schema.relevanceBatches)
      .values({
        orgId,
        brandId,
        days: 1,
        selectedCount: 2,
        processedCount: 1,
        updatedCount: 1,
        status: "running",
      })
      .returning();
    if (!legacy || !fresh || !batch) throw new Error("Missing auxiliary fixtures");
    for (const target of [
      { kind: "suggestions", id: legacy.id },
      { kind: "relevance_batch", id: batch.id },
    ] as const) {
      await expect(
        connection.db.transaction(async (tx) => {
          const state = await lockAiTextSelection(orgId, tx);
          if (!state) throw new Error("Missing tenant");
          return pinAiTextTarget(orgId, tx, state, target);
        }),
      ).rejects.toBeInstanceOf(AiTextSelectionChangedError);
    }
    const pinned = await connection.db.transaction(async (tx) => {
      const state = await lockAiTextSelection(orgId, tx);
      if (!state) throw new Error("Missing tenant");
      return pinAiTextTarget(orgId, tx, state, { kind: "suggestions", id: fresh.id });
    });
    expect(pinned).toMatchObject({ provider: "google", modelId: "legacy-model" });
    await connection.db.transaction(async (tx) => {
      const state = await lockAiTextSelection(orgId, tx);
      if (!state) throw new Error("Missing tenant");
      await tx
        .update(schema.aiTextSettings)
        .set({ provider: "openai", model: "new-model", revision: state.settings.revision + 1 })
        .where(eq(schema.aiTextSettings.orgId, orgId));
      await tx
        .update(schema.topicSuggestionRequests)
        .set({ attempts: 2 })
        .where(eq(schema.topicSuggestionRequests.id, fresh.id));
    });
    await connection.db.transaction(async (tx) => {
      const state = await lockAiTextSelection(orgId, tx);
      if (!state) throw new Error("Missing tenant");
      expect(
        await pinAiTextTarget(orgId, tx, state, { kind: "suggestions", id: fresh.id }),
      ).toEqual(pinned);
    });
    const other = await fixture();
    await expect(
      connection.db.transaction(async (tx) => {
        const state = await lockAiTextSelection(other.orgId, tx);
        if (!state) throw new Error("Missing tenant");
        return pinAiTextTarget(other.orgId, tx, state, { kind: "suggestions", id: fresh.id });
      }),
    ).rejects.toThrow("no longer exists");
  });

  for (const operation of ["run-row mutation", "credential-row mutation"] as const) {
    it(`serializes ${operation} before a competing settings write without a lock upgrade`, async () => {
      const { orgId, runId } = await fixture();
      const locked = deferred();
      const release = deferred();
      const entered = deferred();
      let secondPid = 0;
      let secondAcquired = false;
      const first = connection.db.transaction(async (tx) => {
        const state = await lockAiTextSelection(orgId, tx);
        if (!state) throw new Error("Missing tenant");
        const snapshot = snapshotAiTextSelection(state);
        if (!snapshot) throw new Error("Missing selection");
        pinnedAiCredential(state, snapshot);
        if (operation === "run-row mutation") {
          await tx
            .select({ id: schema.pipelineRuns.id })
            .from(schema.pipelineRuns)
            .where(eq(schema.pipelineRuns.id, runId))
            .for("update");
        } else {
          await tx
            .update(schema.aiCredentials)
            .set({ revision: sql`${schema.aiCredentials.revision} + 1` })
            .where(eq(schema.aiCredentials.id, snapshot.credentialId));
        }
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      const second = connection.db.transaction(async (tx) => {
        const pid = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
        secondPid = pid.rows[0]?.pid ?? 0;
        entered.resolve();
        const state = await lockAiTextSelection(orgId, tx);
        if (!state) throw new Error("Missing tenant");
        secondAcquired = true;
        await tx
          .update(schema.aiTextSettings)
          .set({ model: "edited-model", revision: state.settings.revision + 1 })
          .where(eq(schema.aiTextSettings.orgId, orgId));
      });
      await entered.promise;
      try {
        await expect
          .poll(async () => {
            const result = await connection.pool.query<{ blocked: boolean }>(
              "SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked",
              [secondPid],
            );
            return result.rows[0]?.blocked;
          })
          .toBe(true);
        expect(secondAcquired).toBe(false);
      } finally {
        release.resolve();
      }
      await Promise.all([first, second]);
      expect(secondAcquired).toBe(true);
    });
  }
});
