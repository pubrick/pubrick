import { PLATFORM_MAX_TEXT_LENGTH } from "@pubrick/shared";
import { z } from "zod";
import {
  PermanentPublishError,
  PlatformRejectionError,
  type Publisher,
  type PublisherOptions,
  type PublishResult,
  TransientPublishError,
  UnknownOutcomePublishError,
  type VerifyResult,
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.vk.com/method";
const API_VERSION = "5.199";
export const VK_REQUEST_TIMEOUT_MS = 30_000;

const credentialsSchema = z.object({
  // wall.post requires a user token with wall permission. A community token
  // can read group details but is not sufficient for the publishing contract.
  accessToken: z.string().min(1),
  groupId: z.string().regex(/^[1-9]\d*$/, "Use the positive numeric community ID"),
});
type VkCredentials = z.infer<typeof credentialsSchema>;

const vkEnvelope = z.union([
  z.object({ response: z.unknown() }),
  z.object({ error: z.object({ error_code: z.number(), error_msg: z.string() }) }),
]);
const postResponse = z.object({ post_id: z.number().int().positive() });
const userResponse = z.array(z.object({ id: z.number().int().positive() })).min(1);
const permissionsResponse = z.number().int().nonnegative();
const WALL_PERMISSION = 8192;
const groupResponse = z.object({
  groups: z.array(
    z.object({
      id: z.number().int().positive(),
      name: z.string(),
      is_admin: z.number().optional(),
    }),
  ),
});

const CONNECT_PHASE_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
]);

function connectFailed(error: unknown): boolean {
  for (let cursor: unknown = error, depth = 0; cursor && depth < 5; depth++) {
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === "string" && CONNECT_PHASE_CODES.has(code)) return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

function redact(message: string, token: string): string {
  return token ? message.split(token).join("***") : message;
}

class UnrecognizedResponse extends Error {
  constructor(readonly status: number) {
    super(`VK returned an unrecognized response (HTTP ${status})`);
  }
}

/** A classified VK call. Only VK's own error envelope proves a remote refusal. */
async function call(
  method: string,
  credentials: VkCredentials,
  params: Record<string, string>,
  options?: PublisherOptions,
): Promise<unknown> {
  let envelope: z.infer<typeof vkEnvelope>;
  try {
    const body = new URLSearchParams({
      ...params,
      access_token: credentials.accessToken,
      v: API_VERSION,
    });
    const response = await (options?.fetchImpl ?? fetch)(
      `${options?.baseUrl ?? DEFAULT_BASE_URL}/${method}`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(VK_REQUEST_TIMEOUT_MS),
      },
    );
    const raw: unknown = await response.json();
    const parsed = vkEnvelope.safeParse(raw);
    if (!parsed.success) throw new UnrecognizedResponse(response.status);
    envelope = parsed.data;
  } catch (error) {
    if (error instanceof UnrecognizedResponse) {
      if (error.status >= 400 && error.status < 500 && error.status !== 429) {
        throw new PermanentPublishError(error.message, error.status);
      }
      throw new UnknownOutcomePublishError(error.message, error.status);
    }
    if (connectFailed(error)) {
      throw new TransientPublishError(
        redact(`VK could not be reached: ${String(error)}`, credentials.accessToken),
      );
    }
    throw new UnknownOutcomePublishError(
      redact(`VK request outcome is unknown: ${String(error)}`, credentials.accessToken),
    );
  }

  if ("response" in envelope) return envelope.response;
  const { error_code: code, error_msg: rawMessage } = envelope.error;
  const message = redact(`VK ${code}: ${rawMessage}`, credentials.accessToken);
  // VK's API-specific rate limit and internal error. The envelope confirms
  // nothing was published; a retry is safe. A gateway 5xx does not.
  if (code === 6 || code === 10) throw new TransientPublishError(message);
  throw new PlatformRejectionError(message, code);
}

export const vkPublisher: Publisher<VkCredentials> = {
  platform: "vk",
  maxTextLength: PLATFORM_MAX_TEXT_LENGTH.vk,
  credentialsSchema,

  async publish(credentials, input, options): Promise<PublishResult> {
    if (input.text.length < 1 || input.text.length > this.maxTextLength) {
      throw new PermanentPublishError(
        `Text must be 1..${this.maxTextLength} characters, got ${input.text.length}`,
      );
    }
    const raw = await call(
      "wall.post",
      credentials,
      { owner_id: `-${credentials.groupId}`, from_group: "1", message: input.text },
      options,
    );
    // VK has accepted the post. A malformed success payload cannot cause a
    // retry because that would duplicate it; preserve success without a link.
    const parsed = postResponse.safeParse(raw);
    if (!parsed.success) return { externalId: null, externalUrl: null };
    const externalId = String(parsed.data.post_id);
    return {
      externalId,
      externalUrl: `https://vk.com/wall-${credentials.groupId}_${externalId}`,
    };
  },

  async verify(credentials, options): Promise<VerifyResult> {
    try {
      const users = userResponse.safeParse(await call("users.get", credentials, {}, options));
      if (!users.success) return { ok: false, reason: "VK did not identify a user token" };
      const permissions = permissionsResponse.safeParse(
        await call("account.getAppPermissions", credentials, {}, options),
      );
      if (!permissions.success || (permissions.data & WALL_PERMISSION) === 0) {
        return { ok: false, reason: "The VK user token needs wall permission" };
      }
      const groups = groupResponse.safeParse(
        await call("groups.getById", credentials, { group_id: credentials.groupId }, options),
      );
      if (!groups.success) return { ok: false, reason: "VK returned unexpected group details" };
      const group = groups.data.groups.find((g) => String(g.id) === credentials.groupId);
      if (!group) return { ok: false, reason: "The VK community ID does not match the token" };
      if (group.is_admin !== 1) {
        return { ok: false, reason: `The connected user cannot administer ${group.name}` };
      }
      return { ok: true, account: `id${users.data[0]?.id}`, target: group.name };
    } catch (error) {
      if (
        error instanceof PermanentPublishError ||
        error instanceof TransientPublishError ||
        error instanceof UnknownOutcomePublishError
      ) {
        return { ok: false, reason: error.message };
      }
      throw error;
    }
  },
};

/** Read public counters for a post this integration previously published. */
export async function readVkPostMetrics(
  credentials: Record<string, string>,
  externalId: string,
  options?: PublisherOptions,
): Promise<{
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
} | null> {
  const parsedCredentials = credentialsSchema.safeParse(credentials);
  if (!parsedCredentials.success || !/^[1-9]\d*$/.test(externalId)) return null;
  const raw = await call(
    "wall.getById",
    parsedCredentials.data,
    { posts: `-${parsedCredentials.data.groupId}_${externalId}` },
    options,
  );
  const response = z
    .object({
      items: z.array(
        z.object({
          owner_id: z.number().int(),
          id: z.number().int(),
          views: z.object({ count: z.number().int().nonnegative() }).optional(),
          likes: z.object({ count: z.number().int().nonnegative() }).optional(),
          comments: z.object({ count: z.number().int().nonnegative() }).optional(),
          reposts: z.object({ count: z.number().int().nonnegative() }).optional(),
        }),
      ),
    })
    .safeParse(raw);
  if (!response.success) return null;
  const post = response.data.items.find(
    (item) =>
      item.owner_id === -Number(parsedCredentials.data.groupId) && item.id === Number(externalId),
  );
  if (!post) return null;
  return {
    views: post.views?.count ?? null,
    likes: post.likes?.count ?? null,
    comments: post.comments?.count ?? null,
    shares: post.reposts?.count ?? null,
  };
}
