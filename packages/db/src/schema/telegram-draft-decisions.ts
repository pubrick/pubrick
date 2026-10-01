import {
  TELEGRAM_BINDING_STATES,
  TELEGRAM_CAPABILITY_SEND_STATES,
  TELEGRAM_CAPABILITY_STATES,
  TELEGRAM_CHALLENGE_STATES,
  TELEGRAM_DECISION_ACTIONS,
  TELEGRAM_REMOTE_MUTATIONS,
  TELEGRAM_REMOTE_STATES,
  TELEGRAM_SETUP_STATES,
  TELEGRAM_SUPPORTED_OPERATIONS,
  TELEGRAM_UPDATE_OUTCOMES,
} from "@pubrick/shared";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth.js";
import { enumCheck } from "./enum-check.js";

const instant = (name: string) => timestamp(name, { withTimezone: true });
const org = () =>
  text("org_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" });
const actor = () =>
  text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" });

/** Global inbound claim. No token, secret, chat, Telegram human identity or name.
 * unresolvedAttempts has no expiry: identical retries do not settle older calls. */
export const telegramBotIdentities = pgTable(
  "telegram_bot_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    botId: text("bot_id").notNull(),
    ownerOrgId: text("owner_org_id").references(() => organization.id, { onDelete: "set null" }),
    generation: integer("generation").notNull().default(1),
    enabled: boolean("enabled").notNull().default(false),
    quarantined: boolean("quarantined").notNull().default(false),
    remoteState: text("remote_state", { enum: TELEGRAM_REMOTE_STATES }).notNull().default("idle"),
    remoteMutation: text("remote_mutation", { enum: TELEGRAM_REMOTE_MUTATIONS }),
    remoteGeneration: integer("remote_generation"),
    requestFingerprint: text("request_fingerprint"),
    attemptId: uuid("attempt_id"),
    unresolvedAttempts: integer("unresolved_attempts").notNull().default(0),
    attemptedAt: instant("attempted_at"),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("telegram_bot_identities_bot_idx").on(t.botId),
    unique("telegram_bot_identities_owner_id_idx").on(t.ownerOrgId, t.id),
    index("telegram_bot_identities_owner_idx").on(t.ownerOrgId, t.botId),
    check("telegram_bot_identities_bot_check", sql`${t.botId} ~ '^[1-9][0-9]{0,19}$'`),
    check(
      "telegram_bot_identities_generation_check",
      sql`${t.generation} > 0 AND (${t.remoteGeneration} IS NULL OR ${t.remoteGeneration} > 0)`,
    ),
    enumCheck("telegram_bot_identities_remote_state_check", t.remoteState, TELEGRAM_REMOTE_STATES),
    enumCheck(
      "telegram_bot_identities_remote_mutation_check",
      t.remoteMutation,
      TELEGRAM_REMOTE_MUTATIONS,
    ),
    check(
      "telegram_bot_identities_authority_check",
      sql`NOT ${t.enabled} OR (${t.ownerOrgId} IS NOT NULL AND NOT ${t.quarantined})`,
    ),
    check(
      "telegram_bot_identities_lane_check",
      sql`${t.unresolvedAttempts} >= 0 AND ((${t.remoteState} = 'idle' AND ${t.remoteMutation} IS NULL AND ${t.remoteGeneration} IS NULL AND ${t.requestFingerprint} IS NULL AND ${t.attemptId} IS NULL AND ${t.attemptedAt} IS NULL AND ${t.unresolvedAttempts} = 0) OR (${t.remoteState} <> 'idle' AND ${t.remoteMutation} IS NOT NULL AND ${t.remoteGeneration} IS NOT NULL AND ${t.requestFingerprint} IS NOT NULL AND ${t.requestFingerprint} ~ '^[a-f0-9]{64}$' AND ${t.attemptId} IS NOT NULL AND ${t.attemptedAt} IS NOT NULL)) AND (${t.remoteState} NOT IN ('attempted', 'unknown') OR ${t.unresolvedAttempts} > 0)`,
    ),
  ],
);

/** One row per physical provider mutation. Never TTL-reclaimed; a retry is
 * another attempt and cannot erase a predecessor's unknown completion. */
export const telegramRemoteAttempts = pgTable(
  "telegram_remote_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    botIdentityId: uuid("bot_identity_id")
      .notNull()
      .references(() => telegramBotIdentities.id, { onDelete: "no action" }),
    generation: integer("generation").notNull(),
    mutation: text("mutation", { enum: TELEGRAM_REMOTE_MUTATIONS }).notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    outcome: text("outcome", { enum: ["attempted", "confirmed", "rejected", "unknown"] })
      .notNull()
      .default("attempted"),
    startedAt: instant("started_at").notNull().defaultNow(),
    completedAt: instant("completed_at"),
  },
  (t) => [
    index("telegram_remote_attempts_bot_idx").on(t.botIdentityId, t.startedAt, t.id),
    enumCheck("telegram_remote_attempts_mutation_check", t.mutation, TELEGRAM_REMOTE_MUTATIONS),
    enumCheck("telegram_remote_attempts_outcome_check", t.outcome, [
      "attempted",
      "confirmed",
      "rejected",
      "unknown",
    ]),
    check(
      "telegram_remote_attempts_shape_check",
      sql`${t.generation} > 0 AND ${t.requestFingerprint} ~ '^[a-f0-9]{64}$' AND ((${t.outcome} IN ('attempted', 'unknown') AND ${t.completedAt} IS NULL) OR (${t.outcome} IN ('confirmed', 'rejected') AND ${t.completedAt} IS NOT NULL AND ${t.completedAt} >= ${t.startedAt}))`,
    ),
  ],
);

/** Tenant secrets disappear on organization deletion; route/authentication and
 * exact retry payload remain frozen by generation in repository transactions. */
export const telegramDecisionConfigs = pgTable(
  "telegram_decision_configs",
  {
    orgId: org().primaryKey(),
    botIdentityId: uuid("bot_identity_id").notNull(),
    revision: integer("revision").notNull().default(1),
    generation: integer("generation").notNull().default(1),
    state: text("state", { enum: TELEGRAM_SETUP_STATES }).notNull().default("disabled"),
    routeId: text("route_id").notNull(),
    secretHash: text("secret_hash").notNull(),
    credentialsEncrypted: text("credentials_encrypted").notNull(),
    /** Exact URL, secret and options for one unchanged install generation. */
    retryPayloadEncrypted: text("retry_payload_encrypted").notNull(),
    updatedAt: instant("updated_at").notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "telegram_decision_configs_owned_bot_fk",
      columns: [t.orgId, t.botIdentityId],
      foreignColumns: [telegramBotIdentities.ownerOrgId, telegramBotIdentities.id],
    }).onDelete("no action"),
    uniqueIndex("telegram_decision_configs_route_idx").on(t.routeId),
    check(
      "telegram_decision_configs_revision_check",
      sql`${t.revision} > 0 AND ${t.generation} > 0`,
    ),
    check(
      "telegram_decision_configs_secret_check",
      sql`${t.routeId} ~ '^[A-Za-z0-9_-]{43}$' AND ${t.secretHash} ~ '^[a-f0-9]{64}$' AND length(${t.credentialsEncrypted}) between 1 and 16384 AND length(${t.retryPayloadEncrypted}) between 1 and 16384`,
    ),
    enumCheck("telegram_decision_configs_state_check", t.state, TELEGRAM_SETUP_STATES),
  ],
);

export const telegramBindingChallenges = pgTable(
  "telegram_binding_challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: org(),
    userId: actor(),
    botIdentityId: uuid("bot_identity_id").notNull(),
    generation: integer("generation").notNull(),
    codeHash: text("code_hash").notNull(),
    state: text("state", { enum: TELEGRAM_CHALLENGE_STATES })
      .notNull()
      .default("awaiting_telegram"),
    candidateTelegramUserId: text("candidate_telegram_user_id"),
    candidateChatId: text("candidate_chat_id"),
    candidateDisplayName: text("candidate_display_name"),
    claimedAt: instant("claimed_at"),
    terminalAt: instant("terminal_at"),
    createdAt: instant("created_at").notNull().defaultNow(),
    expiresAt: instant("expires_at").notNull(),
  },
  (t) => [
    uniqueIndex("telegram_binding_challenges_code_idx").on(t.codeHash),
    index("telegram_binding_challenges_issuance_idx").on(t.orgId, t.userId, t.createdAt),
    index("telegram_binding_challenges_cleanup_idx").on(t.expiresAt, t.id),
    index("telegram_binding_challenges_user_idx").on(t.userId, t.id),
    enumCheck("telegram_binding_challenges_state_check", t.state, TELEGRAM_CHALLENGE_STATES),
    check(
      "telegram_binding_challenges_bounds_check",
      sql`length(${t.userId}) between 1 and 255 AND ${t.generation} > 0 AND ${t.codeHash} ~ '^[a-f0-9]{64}$' AND ${t.expiresAt} > ${t.createdAt} AND ${t.expiresAt} <= ${t.createdAt} + interval '5 minutes'`,
    ),
    check(
      "telegram_binding_challenges_candidate_check",
      sql`(${t.candidateTelegramUserId} IS NULL AND ${t.candidateChatId} IS NULL AND ${t.candidateDisplayName} IS NULL AND ${t.claimedAt} IS NULL AND ${t.state} <> 'awaiting_web_confirmation' AND ${t.state} <> 'consumed') OR (${t.candidateTelegramUserId} IS NOT NULL AND ${t.candidateTelegramUserId} ~ '^[1-9][0-9]{0,19}$' AND ${t.candidateChatId} IS NOT NULL AND ${t.candidateChatId} = ${t.candidateTelegramUserId} AND ${t.candidateDisplayName} IS NOT NULL AND length(${t.candidateDisplayName}) <= 256 AND ${t.claimedAt} IS NOT NULL AND ${t.state} <> 'awaiting_telegram')`,
    ),
    check(
      "telegram_binding_challenges_terminal_check",
      sql`(${t.state} IN ('awaiting_telegram', 'awaiting_web_confirmation') AND ${t.terminalAt} IS NULL) OR (${t.state} IN ('consumed', 'revoked', 'expired') AND ${t.terminalAt} IS NOT NULL)`,
    ),
  ],
);

export const telegramBindings = pgTable(
  "telegram_bindings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: org(),
    userId: actor(),
    botIdentityId: uuid("bot_identity_id").notNull(),
    generation: integer("generation").notNull(),
    telegramUserId: text("telegram_user_id").notNull(),
    privateChatId: text("private_chat_id").notNull(),
    state: text("state", { enum: TELEGRAM_BINDING_STATES }).notNull().default("linked"),
    revokedAt: instant("revoked_at"),
    createdAt: instant("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("telegram_bindings_live_user_idx")
      .on(t.orgId, t.botIdentityId, t.userId)
      .where(sql`${t.state} = 'linked'`),
    uniqueIndex("telegram_bindings_live_telegram_idx")
      .on(t.orgId, t.botIdentityId, t.telegramUserId)
      .where(sql`${t.state} = 'linked'`),
    index("telegram_bindings_org_idx").on(t.orgId, t.id),
    index("telegram_bindings_user_idx").on(t.userId, t.id),
    enumCheck("telegram_bindings_state_check", t.state, TELEGRAM_BINDING_STATES),
    check(
      "telegram_bindings_identity_check",
      sql`length(${t.userId}) between 1 and 255 AND ${t.generation} > 0 AND ${t.telegramUserId} ~ '^[1-9][0-9]{0,19}$' AND ${t.privateChatId} = ${t.telegramUserId}`,
    ),
    check(
      "telegram_bindings_revocation_check",
      sql`(${t.state} = 'linked' AND ${t.revokedAt} IS NULL) OR (${t.state} = 'revoked' AND ${t.revokedAt} IS NOT NULL)`,
    ),
  ],
);

// Resource/binding/initial IDs below are immutable scoped references, deliberately
// not deleting FKs. Writers validate them under parent locks before admission.
const capabilityColumns = () => ({
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: org(),
  botIdentityId: uuid("bot_identity_id").notNull(),
  generation: integer("generation").notNull(),
  contentItemId: uuid("content_item_id").notNull(),
  brandId: uuid("brand_id").notNull(),
  snapshotHash: text("snapshot_hash").notNull(),
  snapshotVersion: text("snapshot_version").notNull(),
  tokenHash: text("token_hash").notNull(),
  chatId: text("chat_id").notNull(),
  messageId: text("message_id"),
  state: text("state", { enum: TELEGRAM_CAPABILITY_STATES }).notNull().default("pending"),
  sendState: text("send_state", { enum: TELEGRAM_CAPABILITY_SEND_STATES })
    .notNull()
    .default("pending"),
  sendAttemptedAt: instant("send_attempted_at"),
  terminalAt: instant("terminal_at"),
  createdAt: instant("created_at").notNull().defaultNow(),
  expiresAt: instant("expires_at").notNull(),
});
export const telegramInitialCapabilities = pgTable(
  "telegram_initial_capabilities",
  capabilityColumns(),
  (t) => [
    uniqueIndex("telegram_initial_capabilities_token_idx").on(t.tokenHash),
    index("telegram_initial_capabilities_item_idx").on(t.orgId, t.contentItemId, t.id),
    index("telegram_initial_capabilities_cleanup_idx").on(t.expiresAt, t.id),
    enumCheck("telegram_initial_capabilities_state_check", t.state, TELEGRAM_CAPABILITY_STATES),
    enumCheck(
      "telegram_initial_capabilities_send_state_check",
      t.sendState,
      TELEGRAM_CAPABILITY_SEND_STATES,
    ),
    check(
      "telegram_initial_capabilities_bounds_check",
      sql`${t.generation} > 0 AND ${t.tokenHash} ~ '^[a-f0-9]{64}$' AND ${t.snapshotHash} ~ '^[a-f0-9]{64}$' AND ${t.snapshotVersion} = 'client-review-v1' AND ${t.chatId} ~ '^-?[1-9][0-9]{0,19}$' AND (${t.messageId} IS NULL OR ${t.messageId} ~ '^[1-9][0-9]{0,19}$') AND ${t.expiresAt} > ${t.createdAt} AND ${t.expiresAt} <= ${t.createdAt} + interval '30 minutes'`,
    ),
    check(
      "telegram_initial_capabilities_terminal_check",
      sql`(${t.state} = 'pending') = (${t.terminalAt} IS NULL)`,
    ),
    check(
      "telegram_initial_capabilities_send_check",
      sql`(${t.sendState} = 'pending' AND ${t.sendAttemptedAt} IS NULL AND ${t.messageId} IS NULL) OR (${t.sendState} <> 'pending' AND ${t.sendAttemptedAt} IS NOT NULL AND (${t.sendState} <> 'sent' OR ${t.messageId} IS NOT NULL))`,
    ),
  ],
);
export const telegramActorConfirmations = pgTable(
  "telegram_actor_confirmations",
  {
    ...capabilityColumns(),
    userId: actor(),
    bindingId: uuid("binding_id").notNull(),
    initialCapabilityId: uuid("initial_capability_id").notNull(),
    initialExpiresAt: instant("initial_expires_at").notNull(),
  },
  (t) => [
    uniqueIndex("telegram_actor_confirmations_token_idx").on(t.tokenHash),
    uniqueIndex("telegram_actor_confirmations_pending_actor_idx")
      .on(t.orgId, t.contentItemId, t.userId)
      .where(sql`${t.state} = 'pending'`),
    index("telegram_actor_confirmations_org_idx").on(t.orgId, t.id),
    index("telegram_actor_confirmations_user_idx").on(t.userId, t.id),
    index("telegram_actor_confirmations_cleanup_idx").on(t.expiresAt, t.id),
    enumCheck("telegram_actor_confirmations_state_check", t.state, TELEGRAM_CAPABILITY_STATES),
    enumCheck(
      "telegram_actor_confirmations_send_state_check",
      t.sendState,
      TELEGRAM_CAPABILITY_SEND_STATES,
    ),
    check(
      "telegram_actor_confirmations_bounds_check",
      sql`length(${t.userId}) between 1 and 255 AND ${t.generation} > 0 AND ${t.tokenHash} ~ '^[a-f0-9]{64}$' AND ${t.snapshotHash} ~ '^[a-f0-9]{64}$' AND ${t.snapshotVersion} = 'client-review-v1' AND ${t.chatId} ~ '^[1-9][0-9]{0,19}$' AND (${t.messageId} IS NULL OR ${t.messageId} ~ '^[1-9][0-9]{0,19}$') AND ${t.expiresAt} > ${t.createdAt} AND ${t.expiresAt} <= ${t.createdAt} + interval '30 minutes' AND ${t.expiresAt} <= ${t.initialExpiresAt}`,
    ),
    check(
      "telegram_actor_confirmations_terminal_check",
      sql`(${t.state} = 'pending') = (${t.terminalAt} IS NULL)`,
    ),
    check(
      "telegram_actor_confirmations_send_check",
      sql`(${t.sendState} = 'pending' AND ${t.sendAttemptedAt} IS NULL AND ${t.messageId} IS NULL) OR (${t.sendState} <> 'pending' AND ${t.sendAttemptedAt} IS NOT NULL AND (${t.sendState} <> 'sent' OR ${t.messageId} IS NOT NULL))`,
    ),
  ],
);

/** Minimal seven-day replay evidence, with no provider human identity or payload. */
export const telegramUpdateReceipts = pgTable(
  "telegram_update_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: org(),
    botIdentityId: uuid("bot_identity_id").notNull(),
    updateId: text("update_id").notNull(),
    generation: integer("generation").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    operation: text("operation", { enum: TELEGRAM_SUPPORTED_OPERATIONS }).notNull(),
    outcome: text("outcome", { enum: TELEGRAM_UPDATE_OUTCOMES }).notNull(),
    actorUserId: text("actor_user_id"),
    capabilityId: uuid("capability_id"),
    decisionId: uuid("decision_id"),
    acceptedAt: instant("accepted_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("telegram_update_receipts_replay_idx").on(t.botIdentityId, t.updateId),
    index("telegram_update_receipts_admission_idx").on(t.orgId, t.acceptedAt, t.id),
    index("telegram_update_receipts_cleanup_idx").on(t.acceptedAt, t.id),
    enumCheck(
      "telegram_update_receipts_operation_check",
      t.operation,
      TELEGRAM_SUPPORTED_OPERATIONS,
    ),
    enumCheck("telegram_update_receipts_outcome_check", t.outcome, TELEGRAM_UPDATE_OUTCOMES),
    check(
      "telegram_update_receipts_shape_check",
      sql`${t.generation} > 0 AND ${t.updateId} ~ '^(0|[1-9][0-9]{0,19})$' AND ${t.requestFingerprint} ~ '^[a-f0-9]{64}$' AND (${t.actorUserId} IS NULL OR length(${t.actorUserId}) between 1 and 255) AND (${t.decisionId} IS NULL OR (${t.operation} = 'confirm_reject' AND ${t.outcome} = 'accepted' AND ${t.actorUserId} IS NOT NULL AND ${t.capabilityId} IS NOT NULL))`,
    ),
  ],
);

/** Immutable minimal applied evidence until tenant deletion. No ephemeral FK. */
export const telegramDecisionAudit = pgTable(
  "telegram_decision_audit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: org(),
    contentItemId: uuid("content_item_id").notNull(),
    brandId: uuid("brand_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    bindingId: uuid("binding_id").notNull(),
    botIdentityId: uuid("bot_identity_id").notNull(),
    generation: integer("generation").notNull(),
    capabilityId: uuid("capability_id").notNull(),
    updateId: text("update_id").notNull(),
    action: text("action", { enum: TELEGRAM_DECISION_ACTIONS }).notNull(),
    outcome: text("outcome", { enum: ["rejected"] }).notNull(),
    snapshotHash: text("snapshot_hash").notNull(),
    snapshotVersion: text("snapshot_version").notNull(),
    decidedAt: instant("decided_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("telegram_decision_audit_capability_idx").on(t.capabilityId),
    uniqueIndex("telegram_decision_audit_update_idx").on(t.botIdentityId, t.updateId),
    index("telegram_decision_audit_org_item_idx").on(t.orgId, t.contentItemId, t.id),
    enumCheck("telegram_decision_audit_action_check", t.action, TELEGRAM_DECISION_ACTIONS),
    enumCheck("telegram_decision_audit_outcome_check", t.outcome, ["rejected"]),
    check(
      "telegram_decision_audit_shape_check",
      sql`length(${t.actorUserId}) between 1 and 255 AND ${t.generation} > 0 AND ${t.updateId} ~ '^(0|[1-9][0-9]{0,19})$' AND ${t.snapshotHash} ~ '^[a-f0-9]{64}$' AND ${t.snapshotVersion} = 'client-review-v1'`,
    ),
  ],
);
