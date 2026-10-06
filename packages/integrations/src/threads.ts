import {
  frozenMetaPublicationInputSchema,
  META_PREPARATION_MAX_AGE_MS,
  metaPublicationIdentitySchema,
} from "@pubrick/shared";
import { z } from "zod";
import {
  metaAccountIdSchema,
  type ThreadsCredentials,
  threadsCredentialsSchema,
  threadsCredentialTarget,
} from "./meta-credentials.js";
import { metaRequest } from "./meta-transport.js";
import {
  type ContainerReadiness,
  type PreparedContainer,
  type StagedPreparation,
  type StagedPublisher,
  UnknownPreparationError,
} from "./staged-types.js";
import {
  AcceptedPublicationError,
  PermanentPublishError,
  TransientPublishError,
  UnknownOutcomePublishError,
  type VerifyResult,
} from "./types.js";

const ORIGIN = "https://graph.threads.com";
const MAX_TEXT_LENGTH = 500;
const applicationSchema = z.strictObject({
  clientId: metaAccountIdSchema,
  clientSecret: z
    .string()
    .min(1)
    .max(8192)
    .regex(/^[\x21-\x7e]+$/),
});
// Official sample leaves version unset to use the application's configured default.
// Threads versions are separate from Facebook Graph versions.
const receiptSchema = z.object({ id: metaAccountIdSchema });
const debugSchema = z.object({
  data: z.object({
    type: z.literal("USER"),
    user_id: metaAccountIdSchema,
    scopes: z.array(z.string().min(1).max(200)).max(100),
    expires_at: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    is_valid: z.boolean(),
  }),
});
const identitySchema = z.object({ id: metaAccountIdSchema, username: z.string().min(1).max(200) });
const statusSchema = z.object({
  id: metaAccountIdSchema,
  status: z.enum(["IN_PROGRESS", "FINISHED", "ERROR", "EXPIRED", "PUBLISHED"]),
});

function credentials(value: ThreadsCredentials): ThreadsCredentials {
  const parsed = threadsCredentialsSchema.safeParse(value);
  if (!parsed.success)
    throw new PermanentPublishError("Threads requires a saved access token and account identity");
  return parsed.data;
}
function container(value: PreparedContainer): PreparedContainer {
  const parsed = metaAccountIdSchema.safeParse(value.containerId);
  if (!parsed.success)
    throw new PermanentPublishError("Threads requires a valid saved preparation container");
  return { containerId: parsed.data };
}
function validatePreparation(value: ThreadsCredentials, preparation: StagedPreparation): string {
  const input = frozenMetaPublicationInputSchema.safeParse(preparation.input);
  const identity = metaPublicationIdentitySchema.safeParse(preparation.identity);
  if (
    !input.success ||
    !identity.success ||
    input.data.platform !== "threads" ||
    identity.data.target !== threadsCredentialTarget(value)
  )
    throw new PermanentPublishError(
      "Threads preparation does not match the reviewed delivery and destination",
    );
  if (input.data.image || preparation.imageCapability)
    throw new PermanentPublishError(
      "Threads supports reviewed text only; remove the attachment before preparing",
    );
  if (!input.data.text.trim() || input.data.text.length > MAX_TEXT_LENGTH)
    throw new PermanentPublishError("Threads reviewed text must contain 1 to 500 characters");
  const deadline = Date.parse(preparation.deadlineAt);
  if (
    !Number.isFinite(deadline) ||
    deadline <= Date.now() ||
    deadline > Date.now() + META_PREPARATION_MAX_AGE_MS
  )
    throw new PermanentPublishError("Threads preparation deadline is invalid or expired");
  return input.data.text;
}

export const threadsStagedPublisher: StagedPublisher<ThreadsCredentials> = {
  platform: "threads",
  maxTextLength: MAX_TEXT_LENGTH,
  pollPolicy: Object.freeze({ delayMs: 30_000, maxPolls: 120, deadlineMs: 60 * 60 * 1000 }),
  credentialsSchema: threadsCredentialsSchema,
  credentialTarget: threadsCredentialTarget,
  async verify(value, options): Promise<VerifyResult> {
    try {
      const saved = credentials(value);
      const application = applicationSchema.safeParse(options?.threads);
      if (!application.success)
        throw new PermanentPublishError(
          "Threads requires the server application's credentials for current token inspection",
        );
      const inspected = debugSchema.safeParse(
        await metaRequest(
          ORIGIN,
          "debug_token",
          `TH|${application.data.clientId}|${application.data.clientSecret}`,
          "read",
          new URLSearchParams({ input_token: saved.accessToken }),
          options,
        ),
      );
      if (!inspected.success)
        throw new TransientPublishError(
          "Threads did not confirm current identity, grants, and expiry",
        );
      const grant = inspected.data.data;
      if (!grant.is_valid || grant.expires_at <= Date.now() / 1000)
        throw new PermanentPublishError(
          "Threads access has expired or been revoked; reconnect the account",
        );
      if (
        grant.user_id !== saved.accountId ||
        !grant.scopes.includes("threads_basic") ||
        !grant.scopes.includes("threads_content_publish")
      )
        throw new PermanentPublishError(
          "Threads did not grant publishing access to this saved account",
        );
      const account = identitySchema.safeParse(
        await metaRequest(
          ORIGIN,
          "me",
          saved.accessToken,
          "read",
          new URLSearchParams({ fields: "id,username" }),
          options,
        ),
      );
      if (!account.success)
        throw new TransientPublishError("Threads did not provide a usable account identity");
      if (account.data.id !== saved.accountId)
        throw new PermanentPublishError(
          "Threads account identity changed; create a new channel for this account",
        );
      if (
        [saved.accessToken, application.data.clientSecret].some((secret) =>
          account.data.username.includes(secret),
        )
      )
        throw new TransientPublishError("Threads returned an unusable account name");
      return { ok: true, account: account.data.username, target: threadsCredentialTarget(saved) };
    } catch (error) {
      if (error instanceof PermanentPublishError) return { ok: false, reason: error.message };
      return {
        ok: false,
        reason: "Threads verification could not finish; no publication was attempted",
        indeterminate: true,
      };
    }
  },
  async prepare(value, preparation, options) {
    const saved = credentials(value);
    const text = validatePreparation(saved, preparation);
    const receipt = receiptSchema.safeParse(
      await metaRequest(
        ORIGIN,
        "me/threads",
        saved.accessToken,
        "prepare",
        new URLSearchParams({ media_type: "TEXT", text, auto_publish_text: "false" }),
        options,
      ),
    );
    if (!receipt.success)
      throw new UnknownPreparationError(
        "Threads did not return a usable preparation container; explicit recovery is required",
      );
    return { containerId: receipt.data.id };
  },
  async inspect(value, prepared, options): Promise<ContainerReadiness> {
    const saved = credentials(value);
    const retained = container(prepared);
    const result = statusSchema.safeParse(
      await metaRequest(
        ORIGIN,
        retained.containerId,
        saved.accessToken,
        "read",
        new URLSearchParams({ fields: "id,status,error_message" }),
        options,
      ),
    );
    if (!result.success || result.data.id !== retained.containerId)
      throw new TransientPublishError("Threads did not confirm this container's readiness");
    const statuses: Record<z.infer<typeof statusSchema>["status"], ContainerReadiness["status"]> = {
      IN_PROGRESS: "processing",
      FINISHED: "ready",
      ERROR: "rejected",
      EXPIRED: "expired",
      PUBLISHED: "published_without_receipt",
    };
    return { status: statuses[result.data.status] };
  },
  async finalize(value, prepared, options) {
    const saved = credentials(value);
    const retained = container(prepared);
    const result = await metaRequest(
      ORIGIN,
      "me/threads_publish",
      saved.accessToken,
      "finalize",
      new URLSearchParams({ creation_id: retained.containerId }),
      options,
    );
    const receipt = receiptSchema.safeParse(result);
    if (!receipt.success || receipt.data.id === retained.containerId)
      throw new UnknownOutcomePublishError(
        "Threads did not provide the actual published post receipt; inspect the destination",
      );
    const published = { externalId: receipt.data.id, externalUrl: null };
    const explicitStatus = z.object({ status: z.string() }).safeParse(result);
    if (
      result !== null &&
      typeof result === "object" &&
      Object.hasOwn(result, "status") &&
      (!explicitStatus.success || explicitStatus.data.status !== "PUBLISHED")
    )
      throw new AcceptedPublicationError(
        "Threads accepted a post record without confirming its publication",
        published,
      );
    return published;
  },
};
