import {
  AiTextSelectionChangedError,
  type AiTextSettings,
  type AiTextSnapshot,
  aiTextSnapshotSchema,
  DEFAULT_TEXT_MODELS,
  preferredCredential,
  RUN_ADMISSION_LOCK_NAMESPACE,
} from "@pubrick/shared";
import { asc, eq, getTableName, sql } from "drizzle-orm";
import type { createDb } from "./client.js";
import * as schema from "./schema/index.js";

type Database = ReturnType<typeof createDb>["db"];
export type AiSelectionTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type AiSelectionState = {
  settings: typeof schema.aiTextSettings.$inferSelect;
  credentials: (typeof schema.aiCredentials.$inferSelect)[];
};

/** Advisory admission -> tenant SHARE directly -> settings -> credential IDs.
 * Call before taking run/request rows; never upgrade a weaker tenant lock.
 */
export async function lockAiTextSelection(
  orgId: string,
  tx: AiSelectionTransaction,
): Promise<AiSelectionState | undefined> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(${RUN_ADMISSION_LOCK_NAMESPACE}, hashtext(${orgId}))`,
  );
  const [org] = await tx
    .select({ id: schema.organization.id })
    .from(schema.organization)
    .where(eq(schema.organization.id, orgId))
    .for("share");
  if (!org) return undefined;
  await tx.insert(schema.aiTextSettings).values({ orgId }).onConflictDoNothing();
  const [settings] = await tx
    .select({
      orgId: schema.aiTextSettings.orgId,
      provider: schema.aiTextSettings.provider,
      model: schema.aiTextSettings.model,
      revision: schema.aiTextSettings.revision,
    })
    .from(schema.aiTextSettings)
    .where(eq(schema.aiTextSettings.orgId, orgId))
    .for("update");
  if (!settings) throw new Error("AI settings insert returned no row");
  const credentials = await tx
    .select({
      id: schema.aiCredentials.id,
      orgId: schema.aiCredentials.orgId,
      provider: schema.aiCredentials.provider,
      credentialsEncrypted: schema.aiCredentials.credentialsEncrypted,
      defaultModel: schema.aiCredentials.defaultModel,
      revision: schema.aiCredentials.revision,
      createdAt: schema.aiCredentials.createdAt,
      updatedAt: schema.aiCredentials.updatedAt,
    })
    .from(schema.aiCredentials)
    .where(eq(schema.aiCredentials.orgId, orgId))
    .orderBy(asc(schema.aiCredentials.id))
    .for("update");
  if (settings.provider === null) {
    const legacy = preferredCredential(credentials);
    if (legacy) {
      const [initialized] = await tx
        .update(schema.aiTextSettings)
        .set({
          provider: legacy.provider,
          model: legacy.defaultModel,
          revision: settings.revision + 1,
        })
        .where(eq(schema.aiTextSettings.orgId, orgId))
        .returning({
          orgId: schema.aiTextSettings.orgId,
          provider: schema.aiTextSettings.provider,
          model: schema.aiTextSettings.model,
          revision: schema.aiTextSettings.revision,
        });
      if (initialized) return { settings: initialized, credentials };
    }
  }
  return { settings, credentials };
}

export function aiTextSettingsView(state: AiSelectionState): AiTextSettings {
  const { provider, model, revision } = state.settings;
  return {
    provider,
    model,
    revision,
    modelId: provider ? (model ?? DEFAULT_TEXT_MODELS[provider]) : null,
    configured: provider !== null && state.credentials.some((row) => row.provider === provider),
  };
}

export function snapshotAiTextSelection(state: AiSelectionState): AiTextSnapshot | undefined {
  const { provider, model, revision } = state.settings;
  if (!provider) return undefined;
  const credential = state.credentials.find((row) => row.provider === provider);
  if (!credential) throw new AiTextSelectionChangedError();
  return {
    provider,
    modelId: model ?? DEFAULT_TEXT_MODELS[provider],
    credentialId: credential.id,
    credentialRevision: credential.revision,
    settingsRevision: revision,
  };
}

export function pinnedAiCredential(state: AiSelectionState, snapshot: AiTextSnapshot) {
  const row = state.credentials.find(
    (row) => row.id === snapshot.credentialId && row.provider === snapshot.provider,
  );
  if (!row || row.revision !== snapshot.credentialRevision) throw new AiTextSelectionChangedError();
  return row;
}

/** Commit admission before HTTP: rotations committed afterwards cannot retract that call. */
export async function admitAiTextCall(
  orgId: string,
  database: Database,
  snapshot: AiTextSnapshot,
): Promise<void> {
  await database.transaction(async (tx) => {
    const state = await lockAiTextSelection(orgId, tx);
    if (!state) throw new AiTextSelectionChangedError();
    pinnedAiCredential(state, snapshot);
  });
}

export type AiTextTarget = {
  kind: "suggestions" | "claim_review" | "relevance_batch" | "relevance_item";
  id: string;
};
/** Only fixed schema tables can be interpolated; tenant and ID remain parameters. */
export async function pinAiTextTarget(
  orgId: string,
  tx: AiSelectionTransaction,
  state: AiSelectionState,
  target: AiTextTarget,
): Promise<AiTextSnapshot | undefined> {
  const tables = {
    suggestions: schema.topicSuggestionRequests,
    claim_review: schema.claimReviews,
    relevance_batch: schema.relevanceBatches,
    relevance_item: schema.newsItems,
  };
  const table = sql.identifier(getTableName(tables[target.kind]));
  const priorWork = {
    suggestions: sql`attempts > 1`,
    claim_review: sql`unrecorded_calls > 0`,
    relevance_batch: sql`status <> 'queued' OR processed_count > 0 OR unrecorded_calls > 0`,
    relevance_item: sql`relevance_attempts > 1`,
  };
  const rows = await tx.execute<{ text_selection: AiTextSnapshot | null; prior_work: boolean }>(sql`
    SELECT text_selection, (${priorWork[target.kind]}) AS prior_work FROM ${table} WHERE org_id = ${orgId} AND id = ${target.id} FOR UPDATE`);
  const row = rows.rows[0];
  if (!row) throw new AiTextSelectionChangedError("The AI request no longer exists.");
  if (row.text_selection) {
    const pinned = aiTextSnapshotSchema.parse(row.text_selection);
    pinnedAiCredential(state, pinned);
    return pinned;
  }
  if (row.prior_work)
    throw new AiTextSelectionChangedError(
      "This legacy AI request has previous attempts without retained configuration. Start a new request from current Settings.",
    );
  const pinned = snapshotAiTextSelection(state);
  if (pinned)
    await tx.execute(
      sql`UPDATE ${table} SET text_selection = ${JSON.stringify(pinned)}::jsonb WHERE org_id = ${orgId} AND id = ${target.id}`,
    );
  return pinned;
}
