import { type Facet, RichText } from "@bsky/sdk/richtext";
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

// This adapter supports Bluesky-hosted accounts. A future custom-PDS feature
// needs server-side DID/PDS resolution; a credential-supplied URL is an SSRF risk.
const PDS_URL = "https://bsky.social";
const COLLECTION = "app.bsky.feed.post";
const MAX_GRAPHEMES = 300;
const MAX_IMAGE_BYTES = 2_000_000;
export const BLUESKY_REQUEST_TIMEOUT_MS = 30_000;

const credentialsSchema = z.object({
  handle: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^(?!-)[a-z0-9-]+(?:\.(?!-)[a-z0-9-]+)+$/),
  appPassword: z.string().min(1),
});
type BlueskyCredentials = z.infer<typeof credentialsSchema>;
const sessionSchema = z.object({
  did: z.string().regex(/^did:(plc|web):[a-zA-Z0-9.:%-]+$/),
  handle: z.string().min(1),
  accessJwt: z.string().min(1),
});
const blobSchema = z.object({
  blob: z.object({
    $type: z.literal("blob"),
    ref: z.object({ $link: z.string().min(1) }),
    mimeType: z.literal("image/jpeg"),
    size: z.number().int().positive(),
  }),
});
const recordSchema = z.object({
  uri: z.string().regex(/^at:\/\/did:(?:plc|web):[^/]+\/app\.bsky\.feed\.post\/[a-zA-Z0-9._~:-]+$/),
});
const errorSchema = z.object({ error: z.string().min(1), message: z.string().optional() });
const resolvedHandleSchema = z.object({ did: sessionSchema.shape.did });
type Phase = "prepare" | "publish";

function endpoint(options?: PublisherOptions): string {
  if (options?.baseUrl && options.baseUrl !== PDS_URL) {
    throw new PermanentPublishError("Bluesky only supports the official bsky.social PDS");
  }
  return PDS_URL;
}

function safeMessage(raw: string, secrets: string[]): string {
  return secrets.reduce(
    (message, secret) => (secret ? message.split(secret).join("***") : message),
    raw,
  );
}

const CONNECT_PHASE_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
]);
function connectFailed(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth++) {
    if (CONNECT_PHASE_CODES.has(String((current as { code?: unknown }).code ?? ""))) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

async function xrpc(
  method:
    | "com.atproto.server.createSession"
    | "com.atproto.repo.uploadBlob"
    | "com.atproto.repo.createRecord",
  body: string | Uint8Array,
  credentials: BlueskyCredentials,
  phase: Phase,
  options?: PublisherOptions,
  accessJwt?: string,
): Promise<unknown> {
  const url = `${endpoint(options)}/xrpc/${method}`;
  const secrets = [credentials.appPassword, accessJwt ?? ""];
  let response: Response;
  let raw: unknown;
  try {
    response = await (options?.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: {
        "content-type": typeof body === "string" ? "application/json" : "image/jpeg",
        ...(accessJwt ? { Authorization: `Bearer ${accessJwt}` } : {}),
      },
      body: typeof body === "string" ? body : new Uint8Array(body),
      redirect: "error",
      signal: AbortSignal.timeout(BLUESKY_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const message = safeMessage(String(error), secrets);
    if (phase === "prepare" || connectFailed(error)) {
      throw new TransientPublishError(`Bluesky request did not complete: ${message}`);
    }
    throw new UnknownOutcomePublishError(`Bluesky post outcome is unknown: ${message}`);
  }

  try {
    raw = await response.json();
  } catch {
    const message = `Bluesky returned an unreadable response (HTTP ${response.status})`;
    if (phase === "prepare") {
      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        throw new PermanentPublishError(message, response.status);
      }
      throw new TransientPublishError(message, response.status);
    }
    throw new UnknownOutcomePublishError(message, response.status);
  }

  if (response.ok) return raw;
  const parsed = errorSchema.safeParse(raw);
  // Only a PDS error envelope proves createRecord was refused. A gateway
  // response or an unreadable reply can follow a successful record write.
  const message = safeMessage(
    parsed.success
      ? `Bluesky ${parsed.data.error}: ${parsed.data.message ?? "Request refused"}`
      : `Bluesky HTTP ${response.status}`,
    secrets,
  );
  if (phase === "prepare") {
    if (response.status === 429 || response.status >= 500)
      throw new TransientPublishError(message, response.status);
    if (response.status >= 400 && response.status < 500)
      throw new PermanentPublishError(message, response.status);
    throw new TransientPublishError(message, response.status);
  }
  if (parsed.success && response.status === 429)
    throw new TransientPublishError(message, response.status);
  if (parsed.success && response.status >= 400 && response.status < 500) {
    throw new PlatformRejectionError(message, response.status);
  }
  throw new UnknownOutcomePublishError(message, response.status);
}

async function session(credentials: BlueskyCredentials, options?: PublisherOptions) {
  const raw = await xrpc(
    "com.atproto.server.createSession",
    JSON.stringify({ identifier: credentials.handle, password: credentials.appPassword }),
    credentials,
    "prepare",
    options,
  );
  const parsed = sessionSchema.safeParse(raw);
  if (!parsed.success) throw new TransientPublishError("Bluesky returned unusable session details");
  return parsed.data;
}

function validateImage(bytes: Uint8Array): void {
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    throw new PermanentPublishError("Bluesky cover must be a non-empty JPEG under 2 MB");
  }
  if (
    bytes.length < 4 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes[bytes.length - 2] !== 0xff ||
    bytes[bytes.length - 1] !== 0xd9
  ) {
    throw new PermanentPublishError("Bluesky cover must contain JPEG data");
  }
}

/** Resolve a mention on our fixed PDS; an unresolved handle stays plain text. */
async function resolveHandle(handle: string, options?: PublisherOptions): Promise<string | null> {
  let response: Response;
  try {
    response = await (options?.fetchImpl ?? fetch)(
      `${endpoint(options)}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`,
      {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(BLUESKY_REQUEST_TIMEOUT_MS),
      },
    );
    if (!response.ok) return null;
    const parsed = resolvedHandleSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.did : null;
  } catch {
    return null;
  }
}

function isMention(
  feature: Facet["features"][number],
): feature is Facet["features"][number] & { did: string } {
  return (
    feature.$type === "app.bsky.richtext.facet#mention" &&
    "did" in feature &&
    typeof feature.did === "string"
  );
}

async function resolvedFacets(richText: RichText, options?: PublisherOptions) {
  richText.detectFacetsWithoutResolution();
  const facets = richText.facets;
  if (!facets?.length) return undefined;
  const handles = new Set<string>();
  for (const facet of facets) {
    for (const feature of facet.features) {
      if (isMention(feature)) handles.add(feature.did);
    }
  }
  const resolved = new Map(
    await Promise.all(
      [...handles].map(async (handle) => [handle, await resolveHandle(handle, options)] as const),
    ),
  );
  // The SDK deliberately retains unresolved mentions with did="". Such a
  // facet is invalid under the Lexicon, so omit it and keep the source text.
  return facets.filter((facet) => {
    for (const feature of facet.features) {
      if (!isMention(feature)) continue;
      const did = resolved.get(feature.did);
      if (!did) return false;
      // resolveHandle's schema checked this DID syntax before it reached us.
      feature.did = did as `did:${string}:${string}`;
    }
    return true;
  });
}

export const blueskyPublisher: Publisher<BlueskyCredentials> = {
  platform: "bluesky",
  maxTextLength: MAX_GRAPHEMES,
  credentialsSchema,

  async verify(credentials, options): Promise<VerifyResult> {
    try {
      const authenticated = await session(credentials, options);
      return { ok: true, account: `@${authenticated.handle}`, target: `@${authenticated.handle}` };
    } catch (error) {
      if (error instanceof PermanentPublishError) {
        return { ok: false, reason: error.message };
      }
      if (error instanceof TransientPublishError || error instanceof UnknownOutcomePublishError) {
        return { ok: false, reason: error.message, indeterminate: true };
      }
      throw error;
    }
  },

  async publish(credentials, input, options): Promise<PublishResult> {
    if (input.video) throw new PermanentPublishError("Bluesky video delivery is not available yet");
    const richText = new RichText({ text: input.text });
    const length = richText.graphemeLength;
    if (length < 1 || length > MAX_GRAPHEMES) {
      throw new PermanentPublishError(
        `Bluesky text must be 1..${MAX_GRAPHEMES} graphemes, got ${length}`,
      );
    }
    if (input.image) validateImage(input.image.bytes);
    const authenticated = await session(credentials, options);
    const facets = await resolvedFacets(richText, options);
    let embed: unknown;
    if (input.image) {
      const uploaded = blobSchema.safeParse(
        await xrpc(
          "com.atproto.repo.uploadBlob",
          input.image.bytes,
          credentials,
          "prepare",
          options,
          authenticated.accessJwt,
        ),
      );
      if (!uploaded.success)
        throw new TransientPublishError("Bluesky returned unusable image details");
      embed = {
        $type: "app.bsky.embed.images",
        images: [{ alt: "Post cover image", image: uploaded.data.blob }],
      };
    }
    const raw = await xrpc(
      "com.atproto.repo.createRecord",
      JSON.stringify({
        repo: authenticated.did,
        collection: COLLECTION,
        record: {
          $type: COLLECTION,
          text: richText.text,
          createdAt: new Date().toISOString(),
          ...(facets?.length ? { facets } : {}),
          ...(embed ? { embed } : {}),
        },
      }),
      credentials,
      "publish",
      options,
      authenticated.accessJwt,
    );
    // A 2xx createRecord has already published. An incomplete receipt cannot
    // become a retry because that would create a duplicate post.
    const parsed = recordSchema.safeParse(raw);
    if (
      !parsed.success ||
      !parsed.data.uri.startsWith(`at://${authenticated.did}/${COLLECTION}/`)
    ) {
      return { externalId: null, externalUrl: null };
    }
    const rkey = parsed.data.uri.slice(`at://${authenticated.did}/${COLLECTION}/`.length);
    return {
      externalId: parsed.data.uri,
      externalUrl: `https://bsky.app/profile/${authenticated.did}/post/${encodeURIComponent(rkey)}`,
    };
  },
};
