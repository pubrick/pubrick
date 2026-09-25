import {
  adaptationLimit,
  CONTENT_TYPES,
  type ContentType,
  isPinnedAdaptationLimit,
  PLATFORM_IDS,
  type PlatformId,
  PROMPT_ROLES,
  type PromptRole,
} from "@pubrick/shared";
import { contentTypePolicy } from "./steps/content-type-policy.js";
import { instructionsFor } from "./steps/prompt.js";
import {
  BUILT_IN_ROLE_LINES,
  BUILT_IN_ROLE_SOURCES,
  builtInAdapterRoleLines,
  customRoleLines,
} from "./steps/role-manifest.js";

export const ROLE_TEMPLATE_LIMITS = {
  sourceCodePoints: 12_000,
  sourceBytes: 48 * 1024,
  renderedCodePoints: 16_000,
  renderedBytes: 64 * 1024,
} as const;

const BASE_VARIABLES = ["current_date_utc", "content_type", "content_language"] as const;
const ADAPTER_VARIABLES = ["channel_platform", "channel_limit"] as const;
const TOKEN_NAME = /^[a-z][a-z0-9_]*$/;
const LANGUAGE_CODE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const CONTROL = /\p{Cc}/u;

export type RoleTemplateVariable =
  | (typeof BASE_VARIABLES)[number]
  | (typeof ADAPTER_VARIABLES)[number];

export type RoleTemplateValues = {
  current_date_utc: string;
  content_type: ContentType;
  content_language: string;
  channel_platform?: PlatformId;
  channel_limit?: number;
};

export type RoleTemplateRender = {
  /** CRLF-canonical source, ready for an immutable revision row. */
  source: string;
  text: string;
  /** Unique variables in first-use order. */
  variables: RoleTemplateVariable[];
};

export type RoleTemplateErrorCode =
  | "invalid_role"
  | "invalid_source"
  | "invalid_values"
  | "source_limit"
  | "render_limit"
  | "control_character"
  | "malformed_token"
  | "unknown_variable";

/** Positions are zero-based Unicode code-point offsets in normalized source. */
export class RoleTemplateError extends Error {
  readonly name = "RoleTemplateError";

  constructor(
    readonly code: RoleTemplateErrorCode,
    message: string,
    readonly position?: number,
  ) {
    super(message);
  }
}

function positionAt(source: string, codeUnitOffset: number): number {
  return Array.from(source.slice(0, codeUnitOffset)).length;
}

function failAt(
  code: RoleTemplateErrorCode,
  source: string,
  codeUnitOffset: number,
  message: string,
): never {
  throw new RoleTemplateError(code, message, positionAt(source, codeUnitOffset));
}

function assertRole(role: PromptRole): void {
  if (!(PROMPT_ROLES as readonly string[]).includes(role)) {
    throw new RoleTemplateError("invalid_role", `Unknown template role: ${String(role)}`);
  }
}

function assertSize(text: string, kind: "source" | "rendered"): void {
  const maxCodePoints =
    kind === "source"
      ? ROLE_TEMPLATE_LIMITS.sourceCodePoints
      : ROLE_TEMPLATE_LIMITS.renderedCodePoints;
  const maxBytes =
    kind === "source" ? ROLE_TEMPLATE_LIMITS.sourceBytes : ROLE_TEMPLATE_LIMITS.renderedBytes;
  if (Array.from(text).length > maxCodePoints || Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new RoleTemplateError(
      kind === "source" ? "source_limit" : "render_limit",
      `${kind} role template exceeds ${maxCodePoints} code points or ${maxBytes} UTF-8 bytes`,
    );
  }
}

/** Kept separate so the rendered bound remains testable as the token set evolves. */
export function assertRoleTemplateRenderedSize(text: string): void {
  assertSize(text, "rendered");
}

function assertNoControls(source: string): void {
  for (let offset = 0; offset < source.length; offset += 1) {
    const character = source[offset];
    if (character !== "\n" && character !== "\t" && CONTROL.test(character ?? "")) {
      failAt("control_character", source, offset, "Role template contains a control character");
    }
  }
}

function assertValues(role: PromptRole, values: RoleTemplateValues): void {
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    throw new RoleTemplateError("invalid_values", "Role template values must be an object");
  }
  const allowed =
    role === "adapter" ? [...BASE_VARIABLES, ...ADAPTER_VARIABLES] : [...BASE_VARIABLES];
  if (
    Object.keys(values).some((key) => !allowed.includes(key as RoleTemplateVariable)) ||
    allowed.some((key) => !Object.hasOwn(values, key))
  ) {
    throw new RoleTemplateError(
      "invalid_values",
      "Role template values have missing or unknown keys",
    );
  }
  const { current_date_utc: date, content_type: type, content_language: language } = values;
  if (
    typeof date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    Number.isNaN(Date.parse(`${date}T00:00:00.000Z`)) ||
    new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date ||
    !(CONTENT_TYPES as readonly string[]).includes(type) ||
    typeof language !== "string" ||
    language.length > 10 ||
    !LANGUAGE_CODE.test(language)
  ) {
    throw new RoleTemplateError(
      "invalid_values",
      "Role template values are not validated run data",
    );
  }
  if (role === "adapter") {
    const { channel_platform: platform, channel_limit: limit } = values;
    if (
      typeof platform !== "string" ||
      !(PLATFORM_IDS as readonly string[]).includes(platform) ||
      typeof limit !== "number" ||
      !isPinnedAdaptationLimit(platform, limit)
    ) {
      throw new RoleTemplateError(
        "invalid_values",
        "Adapter values do not match a known platform limit",
      );
    }
  }
}

/**
 * Render only exact `{{name}}` tokens. `\\{{` and `\\}}` are literal delimiters.
 * Appended values are never scanned, so substitution cannot recurse.
 */
export function renderRoleTemplate(
  role: PromptRole,
  rawSource: string,
  values: RoleTemplateValues,
): RoleTemplateRender {
  assertRole(role);
  if (typeof rawSource !== "string") {
    throw new RoleTemplateError("invalid_source", "Role template source must be a string");
  }
  const source = rawSource.replaceAll("\r\n", "\n");
  assertSize(source, "source");
  if (source.trim() === "") {
    throw new RoleTemplateError("invalid_source", "Role template source cannot be blank");
  }
  assertNoControls(source);
  assertValues(role, values);

  const allowed = new Set<RoleTemplateVariable>(
    role === "adapter" ? [...BASE_VARIABLES, ...ADAPTER_VARIABLES] : BASE_VARIABLES,
  );
  const text: string[] = [];
  const variables = new Set<RoleTemplateVariable>();
  for (let offset = 0; offset < source.length; ) {
    if (source.startsWith("\\{{", offset)) {
      text.push("{{");
      offset += 3;
      continue;
    }
    if (source.startsWith("\\}}", offset)) {
      text.push("}}");
      offset += 3;
      continue;
    }
    if (source.startsWith("{{", offset)) {
      const end = source.indexOf("}}", offset + 2);
      if (end < 0) {
        failAt("malformed_token", source, offset, "Unclosed role template variable");
      }
      const name = source.slice(offset + 2, end);
      if (!TOKEN_NAME.test(name) || source[end + 2] === "}") {
        failAt("malformed_token", source, offset, "Malformed role template variable");
      }
      if (!allowed.has(name as RoleTemplateVariable)) {
        failAt(
          "unknown_variable",
          source,
          offset,
          `Unknown role template variable: ${name}. Allowed: ${[...allowed].join(", ")}`,
        );
      }
      const variable = name as RoleTemplateVariable;
      const replacement = values[variable];
      if (replacement === undefined) {
        failAt("invalid_values", source, offset, `Missing role template value: ${name}`);
      }
      variables.add(variable);
      text.push(String(replacement));
      offset = end + 2;
      continue;
    }
    if (source.startsWith("}}", offset)) {
      failAt("malformed_token", source, offset, "Unexpected role template closing delimiter");
    }
    text.push(source[offset] ?? "");
    offset += 1;
  }
  const rendered = text.join("");
  assertRoleTemplateRenderedSize(rendered);
  return { source, text: rendered, variables: [...variables] };
}

/** Fixed non-tenant sample used for unsaved preview and save validation. */
export function previewRoleTemplate(role: PromptRole, source: string): RoleTemplateRender {
  const channelLimit = adaptationLimit("telegram");
  if (channelLimit === undefined) {
    throw new RoleTemplateError("invalid_values", "No preview limit exists for telegram");
  }
  const values: RoleTemplateValues = {
    current_date_utc: "2026-01-15",
    content_type: "social_post",
    content_language: "en",
    ...(role === "adapter"
      ? { channel_platform: "telegram" as const, channel_limit: channelLimit }
      : {}),
  };
  return renderRoleTemplate(role, source, values);
}

/** Editorial text shown in the editor; protected rules live in code. */
export function builtInRoleTemplateSource(role: PromptRole): string {
  assertRole(role);
  return BUILT_IN_ROLE_SOURCES[role];
}

/**
 * Measure a sample complete instruction without a model call or tenant data.
 * The editable body is followed by code-owned role and content-type rules.
 */
export function previewRoleTemplateInstruction(
  role: PromptRole,
  source: string,
): { instructionBytes: number } {
  const rendered = previewRoleTemplate(role, source);
  const instruction = instructionsFor(
    {
      brand: {
        name: "Example Brand",
        voice: "Clear and practical",
        audience: "Readers",
        contentLanguage: "en",
      },
      now: () => new Date("2026-01-15T00:00:00.000Z"),
    },
    [...customRoleLines(role, rendered.text), ...contentTypePolicy("social_post", role)],
  );
  const instructionBytes = Buffer.byteLength(instruction, "utf8");
  if (instructionBytes > 96 * 1024) {
    throw new RoleTemplateError("render_limit", "Complete role instruction exceeds 96 KiB");
  }
  return { instructionBytes };
}

export type RoleTemplateInstructionInput = {
  role: PromptRole;
  /** Null means the byte-compatible built-in role; a string selects editable prose. */
  source: string | null;
  contentType: ContentType;
  claimDateUtc: string;
  brand: { name: string; voice: string | null; audience: string | null; contentLanguage: string };
  channel?: { name: string; platform: PlatformId; limit: number };
  guidance?: string;
};

/** Compose once at first claim. Resume reads the stored instruction, never this function. */
export function composeRoleTemplateInstruction(input: RoleTemplateInstructionInput): string {
  const { role, channel } = input;
  if (role === "adapter" && !channel) {
    throw new RoleTemplateError("invalid_values", "An adapter instruction needs a channel");
  }
  if (role !== "adapter" && channel) {
    throw new RoleTemplateError("invalid_values", "Only an adapter instruction has a channel");
  }
  if (channel && adaptationLimit(channel.platform) !== channel.limit) {
    throw new RoleTemplateError("invalid_values", "Adapter limit does not match its platform");
  }
  const values: RoleTemplateValues = {
    current_date_utc: input.claimDateUtc,
    content_type: input.contentType,
    content_language: input.brand.contentLanguage,
    ...(channel ? { channel_platform: channel.platform, channel_limit: channel.limit } : {}),
  };
  const base =
    input.source === null
      ? role === "adapter"
        ? builtInAdapterRoleLines(channel as NonNullable<typeof channel>)
        : BUILT_IN_ROLE_LINES[role]
      : customRoleLines(role, renderRoleTemplate(role, input.source, values).text, channel);
  const instruction = instructionsFor(
    { brand: input.brand, now: () => new Date(`${input.claimDateUtc}T00:00:00.000Z`) },
    [
      ...base,
      ...contentTypePolicy(input.contentType, role),
      ...(input.guidance
        ? ["", "Additional guidance set by this organization:", input.guidance]
        : []),
    ],
  );
  if (Buffer.byteLength(instruction, "utf8") > 96 * 1024) {
    throw new RoleTemplateError("render_limit", "Complete role instruction exceeds 96 KiB");
  }
  return instruction;
}
