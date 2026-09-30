import { createPrivateKey } from "node:crypto";
import { createGoogleVertex } from "@ai-sdk/google-vertex";
import { JWT } from "google-auth-library";
import { googleProxyFetch, isAllowedGoogleProxy } from "./google-transport.js";
import type { AiCredential } from "./provider.js";
import {
  ProviderPreflightError,
  ProviderPreflightTransientError,
  preflightError,
} from "./provider-preflight.js";

type VertexCredential = Extract<AiCredential, { provider: "vertex" }>;
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const VERTEX_HOSTS = {
  global: "https://aiplatform.googleapis.com",
  us: "https://aiplatform.us.rep.googleapis.com",
  eu: "https://aiplatform.eu.rep.googleapis.com",
} as const;

export function validateVertexCredential(credential: VertexCredential): void {
  if (credential.proxyUrl && !isAllowedGoogleProxy(credential.proxyUrl))
    throw new ProviderPreflightError("Invalid or non-public Vertex proxy destination");
  if (credential.authMode === "service_account") {
    try {
      const key = createPrivateKey(credential.serviceAccount.private_key);
      if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048)
        throw new Error("Unsupported signing key");
    } catch {
      throw new ProviderPreflightError(
        "Vertex requires a valid RSA service-account private key",
        "invalid_key",
      );
    }
  }
}

/** Never accepts an OAuth destination, ambient proxy, redirect or auth discovery. */
function fixedFetch(endpoint: string, proxyUrl?: string): typeof fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (endpoint === TOKEN_URL ? url !== TOKEN_URL : !url.startsWith(`${endpoint}/models/`))
      throw new ProviderPreflightError("Vertex request is outside its fixed API endpoint");
    const next = { ...init, redirect: "manual" as const };
    return proxyUrl ? googleProxyFetch(input, next, proxyUrl) : fetch(input, next);
  };
}

/** Native JWT signing/refresh, with sanitized local failures before model dispatch. */
class WorkspaceJWT extends JWT {
  protected override async refreshTokenNoCache() {
    try {
      const result = await super.refreshTokenNoCache();
      if (typeof result.tokens.access_token !== "string" || !result.tokens.access_token.trim())
        throw new ProviderPreflightTransientError("Vertex authorization returned no access token");
      return result;
    } catch (error) {
      const local = preflightError(error);
      if (local) throw local;
      const status =
        typeof error === "object" &&
        error !== null &&
        "response" in error &&
        typeof error.response === "object" &&
        error.response !== null &&
        "status" in error.response
          ? error.response.status
          : undefined;
      if (status === 400 || status === 401)
        throw new ProviderPreflightError(
          "Vertex service-account authorization was rejected",
          "invalid_key",
        );
      if (typeof status === "number" && status >= 300 && status < 500 && status !== 429)
        throw new ProviderPreflightError(
          "Vertex service-account authorization was refused",
          "provider_refused",
        );
      throw new ProviderPreflightTransientError("Vertex authorization could not be completed");
    }
  }
}

export function vertexModel(credential: VertexCredential, modelId: string) {
  validateVertexCredential(credential);
  if (!/^gemini-[a-z0-9.-]+$/.test(modelId))
    throw new ProviderPreflightError(
      "Use a Gemini publisher model ID for Vertex",
      "model_not_found",
    );
  if (credential.authMode === "express") {
    const baseURL = "https://aiplatform.googleapis.com/v1/publishers/google";
    return createGoogleVertex({
      apiKey: credential.apiKey,
      baseURL,
      fetch: fixedFetch(baseURL, credential.proxyUrl ?? undefined),
    })(modelId);
  }
  const baseURL = `${VERTEX_HOSTS[credential.location]}/v1beta1/projects/${credential.project}/locations/${credential.location}/publishers/google`;
  const client = new WorkspaceJWT({
    email: credential.serviceAccount.client_email,
    key: credential.serviceAccount.private_key,
    keyId: credential.serviceAccount.private_key_id,
    scopes: [SCOPE],
    transporterOptions: {
      fetchImplementation: fixedFetch(TOKEN_URL, credential.proxyUrl ?? undefined),
      maxRedirects: 0,
      retry: false,
      timeout: 30_000,
      // A supplied fetch transport never consumes the environment proxy agent.
      noProxy: [/.*/],
    },
  });
  return createGoogleVertex({
    // Empty is intentional at BOTH native SDK factory levels: undefined would
    // inherit GOOGLE_VERTEX_API_KEY and silently bill the operator instead.
    apiKey: "",
    project: credential.project,
    location: credential.location,
    baseURL,
    googleAuthOptions: { authClient: client, projectId: credential.project },
    fetch: fixedFetch(baseURL, credential.proxyUrl ?? undefined),
  })(modelId);
}
