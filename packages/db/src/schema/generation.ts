import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth.js";
import { brands, channels } from "./content.js";
import { adaptations, CONTENT_ORIGINS, contentItems } from "./content-items.js";

/** Model providers a BYOK key can be stored for. */
export const AI_PROVIDERS = ["google", "openrouter"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

/**
 * Generation run lifecycle.
 *
 * `awaiting_review` is deliberately NOT a member: nothing in increment 1
 * transitions into it, and a status no code can reach is a decision deferred
 * without an owner. Increment 2 adds it with its own migration.
 */
export const RUN_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * Where a ledger row's dollar figure came from. `unknown` is a real outcome —
 * OpenRouter's cost field is optional and the price table has a long tail — and
 * it is why `cost_usd` is nullable: summing a missing cost as zero renders a
 * confident, wrong number.
 */
export const COST_SOURCES = ["provider_reported", "price_table", "unknown"] as const;
export type CostSource = (typeof COST_SOURCES)[number];

/** A ledger row exists even when the call failed after the provider counted tokens. */
export const LEDGER_STATUSES = ["ok", "errored"] as const;
export type LedgerStatus = (typeof LEDGER_STATUSES)[number];

/**
 * Whose key paid for the call. Always `byok` in increment 1 — the column exists
 * now so the later platform-key quota queries need no migration.
 */
export const KEY_OWNERSHIPS = ["byok", "platform"] as const;
export type KeyOwnership = (typeof KEY_OWNERSHIPS)[number];

/**
 * How much of a body a version row holds. `full` is a whole body — the only
 * kind that can be restored, listed as history, or answer the publish gate's
 * "did a human delete something" clause. `fragment` is a refine proposal's
 * replacement text, which is evidence of a touch but is not a body.
 *
 * `full` is the default because it is what every row written before fragments
 * existed already is.
 */
export const VERSION_SCOPES = ["full", "fragment"] as const;
export type VersionScope = (typeof VERSION_SCOPES)[number];

/**
 * What a run was asked to produce. `kind` is discriminated from the start so
 * watched sources can add `"topic"` without a migration.
 */
export type RunInput = { kind: "brief"; text: string; channelIds: string[] };

/**
 * One entry per finished step, keyed `researcher | writer | editor | factcheck`
 * or `adapter:<channelId>` — a single `adapter` key would make a crash
 * mid-fan-out re-run every channel that already succeeded, which is the exact
 * re-spend checkpoints exist to prevent. A key's presence means "skip on resume".
 */
export type RunStepCheckpoint = {
  status: "succeeded" | "failed";
  output?: unknown;
  usage?: unknown;
  finishedAt?: string;
};

/** One BYOK provider key per org. */
export const aiCredentials = pgTable(
  "ai_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: AI_PROVIDERS }).notNull(),
    // AES-256-GCM blob produced by @pubrick/shared encryptJson; never exposed via API.
    credentialsEncrypted: text("credentials_encrypted").notNull(),
    /** Null falls back to the provider's built-in default model. */
    defaultModel: text("default_model"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => new Date())
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("ai_credentials_org_id_idx").on(t.orgId),
    uniqueIndex("ai_credentials_org_id_provider_idx").on(t.orgId, t.provider),
  ],
);

/** One row per generation. */
export const pipelineRuns = pgTable(
  "pipeline_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    input: jsonb("input").$type<RunInput>().notNull(),
    status: text("status", { enum: RUN_STATUSES }).notNull().default("queued"),
    currentStep: text("current_step"),
    steps: jsonb("steps").$type<Record<string, RunStepCheckpoint>>().notNull().default({}),
    /**
     * Set on success. `set null` rather than cascade: a run is a record of what
     * was spent and when, and it must outlive the draft it produced.
     */
    contentItemId: uuid("content_item_id").references(() => contentItems.id, {
      onDelete: "set null",
    }),
    error: text("error"),
    /** A failed or cancelled run stays on the queue strip until a human dismisses it. */
    dismissedAt: timestamp("dismissed_at"),
    /**
     * Fencing. A pg-boss heartbeat does not extend `expireInSeconds`, so a run
     * that outlives its expiry can be handed to a second handler while the
     * first is still working. The handler claims the run by writing its job id
     * and a lease here; every checkpoint and the terminal write carry
     * `AND active_job_id = $jobId`.
     */
    activeJobId: text("active_job_id"),
    leaseExpiresAt: timestamp("lease_expires_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => new Date())
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("pipeline_runs_org_id_idx").on(t.orgId),
    index("pipeline_runs_brand_id_idx").on(t.brandId),
    /** The queue strip reads open runs by status on every poll. */
    index("pipeline_runs_status_idx").on(t.status),
  ],
);

/**
 * One row per model call, including calls that failed after the provider had
 * counted tokens. Rows are written in their own transaction, immediately,
 * before the step's checkpoint: a failed run must not lose the record of what
 * it already spent.
 */
export const usageLedger = pgTable(
  "usage_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /**
     * Null for calls made outside a run (the editor's refine verbs). `set null`
     * on delete, never cascade: the money was spent whatever happened to the run,
     * and the org's spend-to-date is summed from these rows.
     */
    runId: uuid("run_id").references(() => pipelineRuns.id, { onDelete: "set null" }),
    step: text("step").notNull(),
    /** Set for adapter calls, which are made once per channel. */
    channelId: uuid("channel_id").references(() => channels.id, { onDelete: "set null" }),
    /**
     * What the call was spent on, for calls made outside a run: an editor
     * refine has no `run_id`, so without these nothing can answer what refining
     * a given draft cost. `set null` on delete for the same reason `run_id` is —
     * the money was spent whatever happened to the draft, and the org's
     * spend-to-date is summed from these rows.
     */
    contentItemId: uuid("content_item_id").references(() => contentItems.id, {
      onDelete: "set null",
    }),
    /**
     * Set when a call targeted one channel's override rather than the master
     * body. Whether a refine can target an adaptation at all is still 2b-2's to
     * decide; the column is added while this migration is open, because an
     * unused nullable column is cheaper than a second migration.
     */
    adaptationId: uuid("adaptation_id").references(() => adaptations.id, { onDelete: "set null" }),
    /** 2 for a structured-output repair retry of the same step. */
    attempt: integer("attempt").notNull().default(1),
    provider: text("provider", { enum: AI_PROVIDERS }).notNull(),
    modelId: text("model_id").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    /** Kept because Gemini 3.x bills thinking tokens at the output rate. */
    reasoningTokens: integer("reasoning_tokens").notNull().default(0),
    /** Null when nothing could price the call; read `cost_source` before summing. */
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 }),
    costSource: text("cost_source", { enum: COST_SOURCES }).notNull(),
    status: text("status", { enum: LEDGER_STATUSES }).notNull(),
    responseMs: integer("response_ms").notNull().default(0),
    keyOwnership: text("key_ownership", { enum: KEY_OWNERSHIPS }).notNull().default("byok"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("usage_ledger_org_id_idx").on(t.orgId),
    /** The finished draft shows a cost summed over one run's rows. */
    index("usage_ledger_run_id_idx").on(t.runId),
  ],
);

/**
 * Append-only text history, covering both the item and its adaptations. The
 * first `ai` row of each is the provenance reference: a sentence still matching
 * it verbatim is untouched AI text.
 */
export const contentVersions = pgTable(
  "content_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    contentItemId: uuid("content_item_id")
      .notNull()
      .references(() => contentItems.id, { onDelete: "cascade" }),
    /** Null for a version of the master body; set for a per-channel adaptation. */
    adaptationId: uuid("adaptation_id").references(() => adaptations.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    title: text("title"),
    origin: text("origin", { enum: CONTENT_ORIGINS }).notNull(),
    /**
     * Whole body or refine fragment. Defaulted so every row written before this
     * column keeps exactly the meaning it had: a whole body. Restore, history
     * and the gate's deletion clause all read `full` rows only — a fragment is
     * shorter than the body it edits, and counting its sentences as the body's
     * would read every refine as a deletion.
     */
    scope: text("scope", { enum: VERSION_SCOPES }).notNull().default("full"),
    runId: uuid("run_id").references(() => pipelineRuns.id, { onDelete: "set null" }),
    /** Null for AI-written versions. */
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("content_versions_org_id_idx").on(t.orgId),
    index("content_versions_content_item_id_idx").on(t.contentItemId),
    /** The publish rule compares each adaptation against its own first AI version. */
    index("content_versions_adaptation_id_idx").on(t.adaptationId),
  ],
);
