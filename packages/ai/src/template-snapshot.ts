import { createHash } from "node:crypto";
import {
  CONTENT_TYPES,
  isPinnedAdaptationLimit,
  PLATFORM_IDS,
  PROMPT_ROLES,
} from "@pubrick/shared";
import { z } from "zod";
import {
  builtInRoleTemplateSource,
  previewRoleTemplate,
  renderRoleTemplate,
} from "./role-template.js";

export const TEMPLATE_ENGINE_VERSION = "role-template-v1";
export const MAX_PINNED_INSTRUCTION_BYTES = 96 * 1024;

const sha = z.string().regex(/^[0-9a-f]{64}$/);
const instruction = z.strictObject({ text: z.string(), sha256: sha });
const selection = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("default"),
    revisionId: z.null(),
    version: z.null(),
    source: z.string(),
    sourceSha256: sha,
  }),
  z.strictObject({
    kind: z.literal("revision"),
    revisionId: z.uuid(),
    version: z.number().int().positive(),
    source: z.string(),
    sourceSha256: sha,
  }),
]);
const roleSelections = z.strictObject({
  researcher: selection,
  writer: selection,
  editor: selection,
  factcheck: selection,
  adapter: selection,
});
const snapshotSchema = z.strictObject({
  formatVersion: z.literal(1),
  engineVersion: z.literal(TEMPLATE_ENGINE_VERSION),
  roles: roleSelections,
  receipt: z.strictObject({
    contentType: z.enum(CONTENT_TYPES),
    claimDateUtc: z.iso.date(),
    brand: z.strictObject({
      name: z.string(),
      voice: z.string().nullable(),
      audience: z.string().nullable(),
      contentLanguage: z.string(),
    }),
    channels: z.array(
      z.strictObject({
        id: z.uuid(),
        name: z.string(),
        platform: z.enum(PLATFORM_IDS),
        limit: z.number().int().positive(),
      }),
    ),
  }),
  receiptSha256: sha,
  instructions: z.strictObject({
    researcher: instruction,
    writer: instruction,
    editor: instruction,
    factcheck: instruction,
    adapters: z.record(z.string(), instruction),
  }),
});

export type TemplateSnapshot = z.infer<typeof snapshotSchema>;

/** Invalid persisted evidence is never repaired from today's active templates. */
export class InvalidTemplateSnapshotError extends Error {
  readonly name = "InvalidTemplateSnapshotError";

  constructor(reason: string) {
    super(`role template snapshot is invalid: ${reason}`);
  }
}

export function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Fixed field order makes the hash independent of JSONB object-key ordering. */
export function receiptDigest(receipt: TemplateSnapshot["receipt"]): string {
  return digest(
    JSON.stringify([
      receipt.contentType,
      receipt.claimDateUtc,
      [
        receipt.brand.name,
        receipt.brand.voice,
        receipt.brand.audience,
        receipt.brand.contentLanguage,
      ],
      receipt.channels.map((channel) => [
        channel.id,
        channel.name,
        channel.platform,
        channel.limit,
      ]),
    ]),
  );
}

function invalid(reason: string): never {
  throw new InvalidTemplateSnapshotError(reason);
}

/** Validate the entire persisted receipt before a provider call or decision attribution. */
export function validateTemplateSnapshot(raw: unknown): TemplateSnapshot {
  const result = snapshotSchema.safeParse(raw);
  if (!result.success) invalid(result.error.issues.map((issue) => issue.path.join(".")).join(", "));
  const value = result.data;
  if (receiptDigest(value.receipt) !== value.receiptSha256) invalid("typed receipt hash");
  const channelIds = new Set<string>();
  for (const channel of value.receipt.channels) {
    if (channelIds.has(channel.id)) invalid("duplicate channel");
    channelIds.add(channel.id);
    if (!isPinnedAdaptationLimit(channel.platform, channel.limit)) invalid("adapter limit");
  }
  const adapterIds = Object.keys(value.instructions.adapters);
  if (adapterIds.length !== channelIds.size || adapterIds.some((id) => !channelIds.has(id))) {
    invalid("adapter instruction keys");
  }
  for (const role of PROMPT_ROLES) {
    const pinned = value.roles[role];
    if (digest(pinned.source) !== pinned.sourceSha256) invalid(`${role} source hash`);
    if (pinned.kind === "default" && pinned.source !== builtInRoleTemplateSource(role)) {
      invalid(`${role} built-in source`);
    }
    try {
      if (previewRoleTemplate(role, pinned.source).source !== pinned.source) {
        invalid(`${role} source normalization`);
      }
    } catch {
      invalid(`${role} source syntax`);
    }
    const channels = role === "adapter" ? value.receipt.channels : [undefined];
    for (const channel of channels) {
      try {
        renderRoleTemplate(role, pinned.source, {
          current_date_utc: value.receipt.claimDateUtc,
          content_type: value.receipt.contentType,
          content_language: value.receipt.brand.contentLanguage,
          ...(channel ? { channel_platform: channel.platform, channel_limit: channel.limit } : {}),
        });
      } catch {
        invalid(`${role} source syntax or values`);
      }
    }
  }
  const instructions = [
    value.instructions.researcher,
    value.instructions.writer,
    value.instructions.editor,
    value.instructions.factcheck,
    ...Object.values(value.instructions.adapters),
  ];
  for (const pinned of instructions) {
    if (!pinned.text || Buffer.byteLength(pinned.text, "utf8") > MAX_PINNED_INSTRUCTION_BYTES) {
      invalid("instruction size");
    }
    if (digest(pinned.text) !== pinned.sha256) invalid("instruction hash");
  }
  return value;
}

export function pinnedInstructionMap(snapshot: TemplateSnapshot): Record<string, string> {
  const map: Record<string, string> = {};
  for (const role of PROMPT_ROLES) {
    if (role !== "adapter") map[role] = snapshot.instructions[role].text;
  }
  for (const [id, instruction] of Object.entries(snapshot.instructions.adapters)) {
    map[`adapter:${id}`] = instruction.text;
  }
  return map;
}
