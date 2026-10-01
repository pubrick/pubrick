import { z } from "zod";

/** Product admission/retention bounds; neither provider quotas nor remote leases. */
export const TELEGRAM_DECISION_LIMITS = {
  challengeLifetimeSeconds: 300,
  challengeWindowSeconds: 600,
  challengesPerUser: 5,
  challengesPerOrg: 100,
  capabilityLifetimeSeconds: 1800,
  liveCapabilitiesPerOrg: 2000,
  supportedUpdateWindowSeconds: 3600,
  supportedUpdatesPerOrg: 10000,
  requestBodyBytes: 65536,
  quarantinedIdentitiesPerOrg: 5,
  challengeRetentionSeconds: 86400,
  replayRetentionSeconds: 604800,
  capabilityRetentionSeconds: 604800,
  callbackBytes: 64,
  startPayloadCharacters: 64,
} as const;
export const TELEGRAM_SETUP_STATES = [
  "disabled",
  "validating",
  "ownership_conflict",
  "setup_uncertain",
  "active",
  "disconnect_uncertain",
] as const;
export const TELEGRAM_BINDING_STATES = ["linked", "revoked"] as const;
export const TELEGRAM_CHALLENGE_STATES = [
  "awaiting_telegram",
  "awaiting_web_confirmation",
  "consumed",
  "revoked",
  "expired",
] as const;
export const TELEGRAM_CAPABILITY_STATES = ["pending", "consumed", "revoked", "expired"] as const;
export const TELEGRAM_CAPABILITY_SEND_STATES = [
  "pending",
  "attempted",
  "sent",
  "rejected",
  "unknown",
] as const;
export const TELEGRAM_REMOTE_MUTATIONS = ["install", "delete"] as const;
export const TELEGRAM_REMOTE_STATES = [
  "idle",
  "attempted",
  "confirmed",
  "rejected",
  "unknown",
] as const;
export const TELEGRAM_SUPPORTED_OPERATIONS = [
  "binding_start",
  "probe_start",
  "initial_reject",
  "confirm_reject",
  "cancel",
] as const;
export const TELEGRAM_UPDATE_OUTCOMES = ["accepted", "refused"] as const;
export const TELEGRAM_DECISION_ACTIONS = ["reject"] as const;
export const TELEGRAM_SNAPSHOT_VERSION = "client-review-v1" as const;
/** Shared cleanup ordering is parent-safe; registry unknown evidence has no TTL. */
export const TELEGRAM_RECORD_ORDER = [
  "telegram_bot_identities",
  "telegram_binding_challenges",
  "telegram_bindings",
  "telegram_initial_capabilities",
  "telegram_actor_confirmations",
  "telegram_update_receipts",
  "telegram_decision_audit",
] as const;

// Never coerce provider numbers: the transport must reject unsafe JSON numbers
// before projecting its normalized decimal-string operation into these DTOs.
export const telegramIdentitySchema = z.string().regex(/^[1-9][0-9]{0,19}$/);
export const telegramChatIdSchema = z.string().regex(/^-?[1-9][0-9]{0,19}$/);
export const telegramUpdateIdSchema = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
export const telegramOpaqueUserIdSchema = z.string().min(1).max(255);
export const telegramHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const telegramOpaqueCodeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const telegramWebhookSecretSchema = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
export const telegramRouteIdSchema = telegramOpaqueCodeSchema;
export const telegramCallbackDataSchema = z.string().regex(/^(ir|cr|ca):[A-Za-z0-9_-]{43}$/);

export const telegramSetupRequestSchema = z.strictObject({ revision: z.number().int().positive() });
export const telegramSetupStatusSchema = z.strictObject({
  state: z.enum(TELEGRAM_SETUP_STATES),
  revision: z.number().int().positive(),
  generation: z.number().int().positive(),
  hasCredentials: z.boolean(),
  remoteMutationBlocked: z.boolean(),
});
export const telegramBindingChallengeRequestSchema = z.strictObject({});
export const telegramBindingConfirmRequestSchema = z.strictObject({ challengeId: z.uuid() });
export const telegramBindingStatusSchema = z.strictObject({
  state: z.enum(["awaiting_telegram", "awaiting_web_confirmation", "linked", "revoked"]),
  bindingId: z.uuid().nullable(),
  challengeId: z.uuid().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  candidate: z
    .strictObject({ telegramUserId: telegramIdentitySchema, displayName: z.string().max(256) })
    .nullable(),
});
/** Normalized supported operation only: unrelated updates have no durable DTO. */
const updateBase = {
  updateId: telegramUpdateIdSchema,
  fromId: telegramIdentitySchema,
  isBot: z.literal(false),
  chatId: telegramChatIdSchema,
  messageId: telegramIdentitySchema,
};
const callbackBase = {
  ...updateBase,
  callbackQueryId: z.string().min(1).max(256),
  messageBotId: telegramIdentitySchema,
};
export const telegramSupportedUpdateSchema = z
  .discriminatedUnion("operation", [
    z.strictObject({
      ...updateBase,
      operation: z.literal("binding_start"),
      chatType: z.literal("private"),
      code: telegramOpaqueCodeSchema,
      displayName: z.string().max(256),
    }),
    z.strictObject({
      ...updateBase,
      operation: z.literal("probe_start"),
      chatType: z.literal("private"),
      code: telegramOpaqueCodeSchema,
    }),
    z.strictObject({
      ...callbackBase,
      operation: z.literal("initial_reject"),
      chatType: z.enum(["private", "group", "supergroup", "channel"]),
      callbackData: z.string().regex(/^ir:[A-Za-z0-9_-]{43}$/),
    }),
    z.strictObject({
      ...callbackBase,
      operation: z.literal("confirm_reject"),
      chatType: z.literal("private"),
      callbackData: z.string().regex(/^cr:[A-Za-z0-9_-]{43}$/),
    }),
    z.strictObject({
      ...callbackBase,
      operation: z.literal("cancel"),
      chatType: z.literal("private"),
      callbackData: z.string().regex(/^ca:[A-Za-z0-9_-]{43}$/),
    }),
  ])
  .superRefine((value, context) => {
    if (value.operation !== "initial_reject" && value.chatId !== value.fromId)
      context.addIssue({
        code: "custom",
        path: ["chatId"],
        message: "Private operation requires the sender's own chat",
      });
  });
export type TelegramSetupStatus = z.infer<typeof telegramSetupStatusSchema>;
export type TelegramBindingStatus = z.infer<typeof telegramBindingStatusSchema>;
export type TelegramSupportedUpdate = z.infer<typeof telegramSupportedUpdateSchema>;
