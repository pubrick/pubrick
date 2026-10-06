import {
  type FrozenMetaPublicationInput,
  META_PUBLICATION_FAILURES,
  META_PUBLICATION_PHASES,
  META_STAGED_PLATFORM_IDS,
} from "@pubrick/shared";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { brands } from "./content.js";
import { enumCheck } from "./enum-check.js";

/**
 * Nonpublic preparation and final-send evidence for one attempt. Resource UUIDs
 * are immutable audit identities: deleting a channel must not erase final intent.
 * Admission/finalization revalidate every live resource in its tenant and brand.
 * Brand/tenant erasure still removes the duplicated approved content.
 */
export const metaPublicationStages = pgTable(
  "meta_publication_stages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id").notNull(),
    adaptationId: uuid("adaptation_id").notNull(),
    contentItemId: uuid("content_item_id").notNull(),
    channelId: uuid("channel_id").notNull(),
    platform: text("platform", { enum: META_STAGED_PLATFORM_IDS }).notNull(),
    attempt: integer("attempt").notNull(),
    inputHash: text("input_hash").notNull(),
    frozenInput: jsonb("frozen_input").$type<FrozenMetaPublicationInput>().notNull(),
    target: text("target").notNull(),
    credentialGeneration: integer("credential_generation").notNull(),
    phase: text("phase", { enum: META_PUBLICATION_PHASES }).notNull(),
    containerId: text("container_id"),
    /** Existing publication claim ID; never a remote container ID. */
    finalPublicationId: uuid("final_publication_id"),
    externalId: text("external_id"),
    externalUrl: text("external_url"),
    leaseToken: uuid("lease_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    preparationDeadline: timestamp("preparation_deadline", { withTimezone: true }).notNull(),
    nextPollAt: timestamp("next_poll_at", { withTimezone: true }),
    pollCount: integer("poll_count").notNull().default(0),
    failureReason: text("failure_reason", { enum: META_PUBLICATION_FAILURES }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    foreignKey({
      name: "meta_publication_stages_brand_org_fk",
      columns: [t.orgId, t.brandId],
      foreignColumns: [brands.orgId, brands.id],
    }).onDelete("cascade"),
    uniqueIndex("meta_publication_stages_org_adaptation_attempt_idx").on(
      t.orgId,
      t.adaptationId,
      t.attempt,
    ),
    index("meta_publication_stages_recovery_idx").on(t.orgId, t.phase, t.updatedAt),
    index("meta_publication_stages_live_target_idx").on(t.orgId, t.adaptationId, t.phase),
    enumCheck("meta_publication_stages_platform_check", t.platform, META_STAGED_PLATFORM_IDS),
    enumCheck("meta_publication_stages_phase_check", t.phase, META_PUBLICATION_PHASES),
    enumCheck(
      "meta_publication_stages_failure_reason_check",
      t.failureReason,
      META_PUBLICATION_FAILURES,
    ),
    check(
      "meta_publication_stages_attempt_check",
      sql`${t.attempt} > 0 and ${t.credentialGeneration} >= 0 and ${t.pollCount} between 0 and 120`,
    ),
    check("meta_publication_stages_input_hash_check", sql`${t.inputHash} ~ '^[a-f0-9]{64}$'`),
    check(
      "meta_publication_stages_target_check",
      sql`(${t.platform} = 'threads' and ${t.target} ~ '^threads:[1-9][0-9]{0,30}$') or (${t.platform} = 'instagram_native' and ${t.target} ~ '^instagram:[1-9][0-9]{0,30}$')`,
    ),
    check(
      "meta_publication_stages_input_check",
      sql`coalesce(
        jsonb_typeof(${t.frozenInput}) = 'object'
        and ${t.frozenInput} ?& array['version','platform','text']
        and ${t.frozenInput}->'version' = '1'::jsonb
        and ${t.frozenInput}->>'platform' = ${t.platform}
        and jsonb_typeof(${t.frozenInput}->'text') = 'string'
        and length(${t.frozenInput}->>'text') <= 4096
        and (${t.frozenInput} - array['version','platform','text','image']::text[]) = '{}'::jsonb
        and (
          (${t.platform} = 'threads' and not (${t.frozenInput} ? 'image'))
          or (
            ${t.platform} = 'instagram_native'
            and jsonb_typeof(${t.frozenInput}->'image') = 'object'
            and (${t.frozenInput}->'image') ?& array['mediaId','sha256','mimeType','width','height','byteSize']
            and ((${t.frozenInput}->'image') - array['mediaId','sha256','mimeType','width','height','byteSize']::text[]) = '{}'::jsonb
            and jsonb_typeof(${t.frozenInput}->'image'->'mediaId') = 'string'
            and ${t.frozenInput}->'image'->>'mediaId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
            and jsonb_typeof(${t.frozenInput}->'image'->'sha256') = 'string'
            and ${t.frozenInput}->'image'->>'sha256' ~ '^[a-f0-9]{64}$'
            and ${t.frozenInput}->'image'->>'mimeType' = 'image/jpeg'
            and jsonb_typeof(${t.frozenInput}->'image'->'width') = 'number'
            and case when ${t.frozenInput}->'image'->>'width' ~ '^[1-9][0-9]{0,4}$' then (${t.frozenInput}->'image'->>'width')::integer <= 20000 else false end
            and jsonb_typeof(${t.frozenInput}->'image'->'height') = 'number'
            and case when ${t.frozenInput}->'image'->>'height' ~ '^[1-9][0-9]{0,4}$' then (${t.frozenInput}->'image'->>'height')::integer <= 20000 else false end
            and jsonb_typeof(${t.frozenInput}->'image'->'byteSize') = 'number'
            and case when ${t.frozenInput}->'image'->>'byteSize' ~ '^[1-9][0-9]{0,7}$' then (${t.frozenInput}->'image'->>'byteSize')::integer <= 10485760 else false end
          )
        ), false)`,
    ),
    check(
      "meta_publication_stages_lease_pair_check",
      sql`(${t.leaseToken} is null) = (${t.leaseUntil} is null)`,
    ),
    check(
      "meta_publication_stages_container_check",
      sql`${t.containerId} is null or ${t.containerId} ~ '^[1-9][0-9]{0,30}$'`,
    ),
    check(
      "meta_publication_stages_receipt_check",
      sql`(${t.externalId} is null or (${t.externalId} ~ '^[1-9][0-9]{0,30}$' and ${t.externalId} is distinct from ${t.containerId})) and (${t.externalUrl} is null or length(${t.externalUrl}) <= 2048)`,
    ),
    check(
      "meta_publication_stages_checkpoint_check",
      sql`(${t.phase} <> 'preparation_intent' or (${t.containerId} is null and ${t.finalPublicationId} is null)) and (${t.phase} <> 'waiting' or (${t.containerId} is not null and ${t.finalPublicationId} is null)) and (${t.phase} not in ('final_intent','final_unknown','published') or (${t.containerId} is not null and ${t.finalPublicationId} is not null)) and (${t.phase} <> 'published' or ${t.externalId} is not null) and (${t.phase} <> 'published_without_receipt' or (${t.containerId} is not null and ${t.externalId} is null))`,
    ),
    check(
      "meta_publication_stages_deadline_check",
      sql`${t.preparationDeadline} > ${t.createdAt} and ${t.preparationDeadline} <= ${t.createdAt} + interval '24 hours'`,
    ),
  ],
);
