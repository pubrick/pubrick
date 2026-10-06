import { z } from "zod";
import {
  type FacebookPageCredentials,
  facebookPageCredentialsSchema,
  facebookPageCredentialTarget,
  metaAccountIdSchema,
} from "./meta-credentials.js";
import { metaRequest } from "./meta-transport.js";
import {
  AcceptedPublicationError,
  PermanentPublishError,
  type Publisher,
  type PublisherOptions,
  TransientPublishError,
  UnknownOutcomePublishError,
  type VerifyResult,
} from "./types.js";

const ORIGIN = "https://graph.facebook.com";
const VERSION = "v26.0";
export const FACEBOOK_PAGE_MAX_DISCOVERY_PAGES = 3;
// Two inspectors, Page identity, bounded User accounts edge, then one create.
export const FACEBOOK_PAGE_MAX_REQUESTS = FACEBOOK_PAGE_MAX_DISCOVERY_PAGES + 4;
const REQUIRED_SCOPES = ["pages_manage_posts", "pages_read_engagement", "pages_show_list"] as const;
const applicationSchema = z.object({
  clientId: metaAccountIdSchema,
  clientSecret: z
    .string()
    .min(1)
    .max(8192)
    .regex(/^[\x21-\x7e]+$/),
});
const debugSchema = z.object({
  data: z.object({
    is_valid: z.boolean(),
    app_id: metaAccountIdSchema,
    type: z.enum(["PAGE", "USER"]),
    user_id: metaAccountIdSchema.optional(),
    profile_id: metaAccountIdSchema.optional(),
    expires_at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    scopes: z.array(z.string().min(1).max(200)).max(100),
    granular_scopes: z
      .array(
        z.object({
          scope: z.string().min(1).max(200),
          target_ids: z.array(metaAccountIdSchema).max(1000).optional(),
        }),
      )
      .max(100)
      .optional(),
  }),
});
const pageSchema = z.object({
  id: metaAccountIdSchema,
  tasks: z.array(z.string().min(1).max(100)).max(50),
});
const accountsSchema = z.object({
  data: z.array(pageSchema).max(100),
  paging: z
    .object({
      cursors: z.object({ after: z.string().min(1).max(2048).optional() }).optional(),
      next: z.string().max(8192).optional(),
    })
    .optional(),
});
const identitySchema = z.object({ id: metaAccountIdSchema, name: z.string().min(1).max(300) });
const receiptSchema = z.object({ id: z.string().regex(/^[1-9]\d{0,30}_[1-9]\d{0,30}$/) });

function parsedCredentials(value: FacebookPageCredentials, options?: PublisherOptions) {
  const credentials = facebookPageCredentialsSchema.safeParse(value);
  const application = applicationSchema.safeParse(options?.facebookPage);
  if (!credentials.success || !application.success)
    throw new PermanentPublishError(
      "Facebook Page requires saved Page/User tokens and the server application's credentials",
    );
  if (options?.baseUrl && options.baseUrl !== ORIGIN && options.baseUrl !== `${ORIGIN}/`)
    throw new PermanentPublishError("Facebook Page requests must use the official endpoint");
  return { credentials: credentials.data, application: application.data };
}
async function publishingProof(
  value: FacebookPageCredentials,
  options?: PublisherOptions,
): Promise<{ account: string; validUntil: number }> {
  const { credentials, application } = parsedCredentials(value, options);
  const appToken = `${application.clientId}|${application.clientSecret}`;
  const readDebug = async (token: string) => {
    const debug = debugSchema.safeParse(
      await metaRequest(
        ORIGIN,
        `${VERSION}/debug_token`,
        appToken,
        "read",
        new URLSearchParams({ input_token: token }),
        options,
      ),
    );
    if (!debug.success)
      throw new TransientPublishError(
        "Facebook did not provide usable application/token permission proof",
      );
    if (
      !debug.data.data.is_valid ||
      debug.data.data.app_id !== application.clientId ||
      (debug.data.data.expires_at !== 0 && debug.data.data.expires_at <= Date.now() / 1000)
    )
      throw new PermanentPublishError(
        "Facebook access is inactive, expired, or belongs to another application",
      );
    for (const scope of REQUIRED_SCOPES) {
      if (!debug.data.data.scopes.includes(scope))
        throw new PermanentPublishError(
          "Facebook did not grant this Page's text publishing permissions",
        );
      const granular = debug.data.data.granular_scopes?.filter((grant) => grant.scope === scope);
      if (
        granular?.some(
          (grant) =>
            grant.target_ids !== undefined && !grant.target_ids.includes(credentials.pageId),
        )
      )
        throw new PermanentPublishError(
          "Facebook publishing permissions do not include the selected Page",
        );
    }
    return debug.data.data;
  };
  const user = await readDebug(credentials.userAccessToken);
  const page = await readDebug(credentials.accessToken);
  if (
    user.type !== "USER" ||
    !user.user_id ||
    page.type !== "PAGE" ||
    (page.profile_id !== undefined && page.profile_id !== credentials.pageId) ||
    (page.user_id !== undefined && page.user_id !== user.user_id)
  )
    throw new PermanentPublishError(
      "Facebook did not confirm the selected Page and its connected User",
    );
  const identified = identitySchema.safeParse(
    await metaRequest(
      ORIGIN,
      `${VERSION}/me`,
      credentials.accessToken,
      "read",
      new URLSearchParams({ fields: "id,name" }),
      options,
    ),
  );
  if (!identified.success)
    throw new TransientPublishError("Facebook did not provide a usable Page identity");
  if (identified.data.id !== credentials.pageId)
    throw new PermanentPublishError(
      "Facebook Page identity changed; reconnect the original destination",
    );
  let cursor: string | undefined;
  let selected = 0;
  let complete = false;
  const seen = new Set<string>();
  for (let index = 0; index < FACEBOOK_PAGE_MAX_DISCOVERY_PAGES; index++) {
    const params = new URLSearchParams({
      fields: "id,tasks",
      limit: "100",
      ...(cursor ? { after: cursor } : {}),
    });
    const accounts = accountsSchema.safeParse(
      await metaRequest(
        ORIGIN,
        `${VERSION}/me/accounts`,
        credentials.userAccessToken,
        "read",
        params,
        options,
      ),
    );
    if (!accounts.success)
      throw new TransientPublishError("Facebook did not provide a usable Page task list");
    for (const account of accounts.data.data) {
      if (account.id !== credentials.pageId) continue;
      selected++;
      if (!account.tasks.includes("CREATE_CONTENT"))
        throw new PermanentPublishError(
          "Facebook did not grant CREATE_CONTENT for the selected Page",
        );
    }
    if (!accounts.data.paging?.next) {
      complete = true;
      break;
    }
    let next: URL;
    try {
      next = new URL(accounts.data.paging.next);
    } catch {
      throw new TransientPublishError("Facebook Page discovery returned an unusable cursor");
    }
    if (
      next.origin !== ORIGIN ||
      next.username ||
      next.password ||
      next.hash ||
      ![`/${VERSION}/me/accounts`, `/${VERSION}/${user.user_id}/accounts`].includes(next.pathname)
    )
      throw new TransientPublishError("Facebook Page discovery returned an unsafe continuation");
    const after = accounts.data.paging.cursors?.after;
    if (!after || seen.has(after))
      throw new TransientPublishError("Facebook Page discovery did not advance its bounded cursor");
    seen.add(after);
    cursor = after;
  }
  if (!complete || selected !== 1)
    throw new PermanentPublishError(
      "Facebook did not confirm one unambiguous selected Page within the bounded discovery window",
    );
  if (
    [credentials.accessToken, credentials.userAccessToken, application.clientSecret].some(
      (secret) => identified.data.name.includes(secret),
    )
  )
    throw new TransientPublishError("Facebook returned an unusable Page name");
  const expiry = (seconds: number) => (seconds === 0 ? Number.POSITIVE_INFINITY : seconds * 1000);
  return {
    account: identified.data.name,
    validUntil: Math.min(expiry(user.expires_at), expiry(page.expires_at)),
  };
}

/** Direct Page text publisher. Registration waits for the complete native connection lifecycle. */
export const facebookPagePublisher: Publisher<FacebookPageCredentials> = {
  platform: "facebook_page",
  maxTextLength: 63206,
  credentialsSchema: facebookPageCredentialsSchema,
  credentialTarget: facebookPageCredentialTarget,
  async verify(value, options): Promise<VerifyResult> {
    try {
      const proof = await publishingProof(value, options);
      return { ok: true, account: proof.account, target: facebookPageCredentialTarget(value) };
    } catch (error) {
      if (error instanceof PermanentPublishError) return { ok: false, reason: error.message };
      return {
        ok: false,
        reason: "Facebook Page verification could not finish; no publication was attempted",
        indeterminate: true,
      };
    }
  },
  async publish(value, input, options) {
    if (
      input.image ||
      input.video ||
      typeof input.text !== "string" ||
      !input.text.trim() ||
      input.text.length > 63206
    )
      throw new PermanentPublishError(
        "Facebook Page supports reviewed text only, up to 63206 characters",
      );
    const { credentials } = parsedCredentials(value, options);
    const proof = await publishingProof(credentials, options);
    await options?.beforeFacebookPageCreate?.();
    if (proof.validUntil <= Date.now())
      throw new PermanentPublishError(
        "Facebook access expired during verification; reconnect the Page",
      );
    const body = await metaRequest(
      ORIGIN,
      `${VERSION}/${credentials.pageId}/feed`,
      credentials.accessToken,
      "finalize",
      new URLSearchParams({ message: input.text, published: "true" }),
      options,
    );
    const parsed = receiptSchema.safeParse(body);
    if (!parsed.success || parsed.data.id.split("_")[0] !== credentials.pageId)
      throw new UnknownOutcomePublishError(
        "Facebook did not return the actual post receipt for this Page; inspect its feed",
      );
    const receipt = { externalId: parsed.data.id, externalUrl: null };
    const explicitlyPublished = z.object({ is_published: z.literal(true) }).safeParse(body);
    if (
      body !== null &&
      typeof body === "object" &&
      Object.hasOwn(body, "is_published") &&
      !explicitlyPublished.success
    )
      throw new AcceptedPublicationError(
        "Facebook accepted a post record without confirming publication",
        receipt,
      );
    return receipt;
  },
};
