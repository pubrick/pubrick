import {
  frozenMetaPublicationInputSchema,
  META_PREPARATION_MAX_AGE_MS,
  metaPublicationIdentitySchema,
} from "@pubrick/shared";
import { z } from "zod";
import {
  type InstagramNativeCredentials,
  instagramCredentialTarget,
  instagramNativeCredentialsSchema,
  metaAccountIdSchema,
} from "./meta-credentials.js";
import { META_REQUEST_TIMEOUT_MS, metaRequest } from "./meta-transport.js";
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

const ORIGIN = "https://graph.instagram.com";
const VERSION = "v26.0";
const receiptSchema = z.object({ id: metaAccountIdSchema });
const accountSchema = z.object({
  user_id: metaAccountIdSchema,
  username: z.string().min(1).max(200),
  account_type: z.string().max(50).optional(),
});
const identitySchema = z.union([
  accountSchema.extend({ data: z.never().optional() }),
  z.object({ data: z.tuple([accountSchema]), user_id: z.never().optional() }),
]);
const limitSchema = z.object({
  data: z.tuple([
    z.object({
      quota_usage: z.number().int().nonnegative(),
      config: z.object({
        quota_total: z.number().int().positive(),
        quota_duration: z.number().int().positive(),
      }),
    }),
  ]),
});
const statusSchema = z.object({
  id: metaAccountIdSchema.optional(),
  status_code: z.enum(["EXPIRED", "ERROR", "FINISHED", "IN_PROGRESS", "PUBLISHED"]),
});
function credentials(value: InstagramNativeCredentials): InstagramNativeCredentials {
  const parsed = instagramNativeCredentialsSchema.safeParse(value);
  if (!parsed.success)
    throw new PermanentPublishError(
      "Instagram requires a saved access token and professional account identity",
    );
  return parsed.data;
}
function container(value: PreparedContainer): PreparedContainer {
  const id = metaAccountIdSchema.safeParse(value.containerId);
  if (!id.success)
    throw new PermanentPublishError("Instagram requires a valid saved preparation container");
  return { containerId: id.data };
}
function imageUrl(
  saved: InstagramNativeCredentials,
  preparation: StagedPreparation,
  trustedOrigin?: string,
): string {
  const input = frozenMetaPublicationInputSchema.safeParse(preparation.input);
  const identity = metaPublicationIdentitySchema.safeParse(preparation.identity);
  if (
    !input.success ||
    !identity.success ||
    input.data.platform !== "instagram_native" ||
    identity.data.target !== instagramCredentialTarget(saved)
  )
    throw new PermanentPublishError(
      "Instagram preparation does not match the reviewed delivery and destination",
    );
  const image = input.data.image;
  if (
    !image ||
    image.byteSize > 8_000_000 ||
    image.width < 320 ||
    image.width > 1440 ||
    image.width * 5 < image.height * 4 ||
    image.width * 100 > image.height * 191
  )
    throw new PermanentPublishError(
      "Instagram requires one JPEG of at most 8 MB, width 320–1440 pixels, and aspect ratio 4:5–1.91:1",
    );
  const text = input.data.text;
  // Conservative syntax admission: do not invent a second provider hashtag parser.
  if (text.length > 2200 || text.split("#").length - 1 > 30 || text.split("@").length - 1 > 20)
    throw new PermanentPublishError(
      "Instagram captions support at most 2200 characters, 30 # markers and 20 @ markers",
    );
  const deadline = Date.parse(preparation.deadlineAt);
  const capability = preparation.imageCapability;
  const expiry = capability && Date.parse(capability.expiresAt);
  if (
    !Number.isFinite(deadline) ||
    deadline <= Date.now() ||
    deadline > Date.now() + META_PREPARATION_MAX_AGE_MS ||
    !capability ||
    !expiry ||
    !Number.isFinite(expiry) ||
    expiry < Date.now() + META_REQUEST_TIMEOUT_MS ||
    expiry > deadline ||
    expiry > Date.now() + META_PREPARATION_MAX_AGE_MS ||
    capability.orgId !== identity.data.orgId ||
    capability.adaptationId !== identity.data.adaptationId ||
    capability.attempt !== identity.data.attempt ||
    capability.mediaId !== image.mediaId ||
    capability.sha256 !== image.sha256 ||
    capability.purpose !== "meta_preparation"
  )
    throw new PermanentPublishError(
      "Instagram approved image access is missing, expired, or bound to a different delivery",
    );
  let url: URL;
  let origin: URL;
  try {
    url = new URL(capability.url);
    origin = new URL(trustedOrigin ?? "");
  } catch {
    throw new PermanentPublishError("Instagram requires a configured public HTTPS media origin");
  }
  if (
    url.protocol !== "https:" ||
    origin.protocol !== "https:" ||
    url.origin !== origin.origin ||
    origin.origin !== trustedOrigin ||
    url.username ||
    url.password ||
    url.hash ||
    origin.username ||
    origin.password
  )
    throw new PermanentPublishError(
      "Instagram image capability must use the server's public HTTPS media origin",
    );
  return url.toString();
}

export const instagramNativeStagedPublisher: StagedPublisher<InstagramNativeCredentials> = {
  platform: "instagram_native",
  maxTextLength: 2200,
  pollPolicy: Object.freeze({ delayMs: 60_000, maxPolls: 5, deadlineMs: 5 * 60 * 1000 }),
  credentialsSchema: instagramNativeCredentialsSchema,
  credentialTarget: instagramCredentialTarget,
  async verify(value, options): Promise<VerifyResult> {
    try {
      const saved = credentials(value);
      if (saved.expiresAt && Date.parse(saved.expiresAt) <= Date.now())
        throw new PermanentPublishError("Instagram access has expired; reconnect the account");
      const identity = identitySchema.safeParse(
        await metaRequest(
          ORIGIN,
          `${VERSION}/me`,
          saved.accessToken,
          "read",
          new URLSearchParams({ fields: "id,user_id,username,account_type" }),
          options,
        ),
      );
      if (!identity.success)
        throw new TransientPublishError(
          "Instagram did not confirm a single professional account identity",
        );
      const account = identity.data.data ? identity.data.data[0] : identity.data;
      if (
        account.user_id !== saved.accountId ||
        (account.account_type !== undefined &&
          !["BUSINESS", "MEDIA_CREATOR"].includes(account.account_type.toUpperCase()))
      )
        throw new PermanentPublishError(
          "Instagram did not confirm the saved professional destination",
        );
      // This documented endpoint requires both native basic and content-publish permissions.
      // It proves this capability now; it is not token introspection or a scope enumeration.
      const limit = limitSchema.safeParse(
        await metaRequest(
          ORIGIN,
          `${VERSION}/${saved.accountId}/content_publishing_limit`,
          saved.accessToken,
          "read",
          new URLSearchParams({ fields: "quota_usage,config" }),
          options,
        ),
      );
      if (!limit.success || account.username.includes(saved.accessToken))
        throw new TransientPublishError("Instagram publishing capability could not be confirmed");
      return { ok: true, account: account.username, target: instagramCredentialTarget(saved) };
    } catch (error) {
      if (error instanceof PermanentPublishError) return { ok: false, reason: error.message };
      return {
        ok: false,
        reason: "Instagram verification could not finish; no publication was attempted",
        indeterminate: true,
      };
    }
  },
  async prepare(value, preparation, options) {
    const saved = credentials(value);
    const url = imageUrl(saved, preparation, options?.approvedMediaOrigin);
    const result = receiptSchema.safeParse(
      await metaRequest(
        ORIGIN,
        `${VERSION}/${saved.accountId}/media`,
        saved.accessToken,
        "prepare",
        new URLSearchParams({ image_url: url, caption: preparation.input.text }),
        options,
      ),
    );
    if (!result.success)
      throw new UnknownPreparationError(
        "Instagram did not return a usable preparation container; explicit recovery is required",
      );
    return { containerId: result.data.id };
  },
  async inspect(value, prepared, options): Promise<ContainerReadiness> {
    const saved = credentials(value);
    const retained = container(prepared);
    const result = statusSchema.safeParse(
      await metaRequest(
        ORIGIN,
        `${VERSION}/${retained.containerId}`,
        saved.accessToken,
        "read",
        new URLSearchParams({ fields: "status_code" }),
        options,
      ),
    );
    if (
      !result.success ||
      (result.data.id !== undefined && result.data.id !== retained.containerId)
    )
      throw new TransientPublishError("Instagram did not confirm this container's readiness");
    const statuses: Record<
      z.infer<typeof statusSchema>["status_code"],
      ContainerReadiness["status"]
    > = {
      IN_PROGRESS: "processing",
      FINISHED: "ready",
      ERROR: "rejected",
      EXPIRED: "expired",
      PUBLISHED: "published_without_receipt",
    };
    return { status: statuses[result.data.status_code] };
  },
  async finalize(value, prepared, options) {
    const saved = credentials(value);
    const retained = container(prepared);
    const body = await metaRequest(
      ORIGIN,
      `${VERSION}/${saved.accountId}/media_publish`,
      saved.accessToken,
      "finalize",
      new URLSearchParams({ creation_id: retained.containerId }),
      options,
    );
    const result = receiptSchema.safeParse(body);
    if (!result.success || result.data.id === retained.containerId)
      throw new UnknownOutcomePublishError(
        "Instagram did not provide an actual published media receipt; inspect the destination",
      );
    const receipt = { externalId: result.data.id, externalUrl: null };
    const explicitStatus = z.object({ status_code: z.string() }).safeParse(body);
    if (
      body !== null &&
      typeof body === "object" &&
      Object.hasOwn(body, "status_code") &&
      (!explicitStatus.success || explicitStatus.data.status_code !== "PUBLISHED")
    )
      throw new AcceptedPublicationError(
        "Instagram accepted a media record without confirming publication",
        receipt,
      );
    return receipt;
  },
};
