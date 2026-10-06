import { HttpException, Injectable } from "@nestjs/common";
import {
  facebookPagePublisher,
  getStagedPublisher,
  type VerifyResult,
} from "@pubrick/integrations";
import {
  META_CONNECTION_PROVIDERS,
  type MetaAuthorizationStart,
  type MetaConnectionProvider,
  metaAuthorizationStartedSchema,
} from "@pubrick/shared";
import { badRequest, conflict } from "../api-error";
import { env, metaApplications } from "../env";
import { MetaAccountClient, type MetaAccountConnection } from "./meta-account-client";
import { MetaConnectionsRepository, validateMetaConnection } from "./meta-connections.repository";
import { MetaOAuthClient, MetaOAuthClientError } from "./meta-oauth-client";
import { type MetaRuntimeConfiguration, metaRuntimeConfiguration } from "./meta-runtime-config";

@Injectable()
export class MetaConnectionsService {
  constructor(private readonly connections: MetaConnectionsRepository) {}

  configuration(_orgId: string) {
    return {
      providers: META_CONNECTION_PROVIDERS.map((provider) => ({
        provider,
        available: Boolean(
          metaRuntimeConfiguration(
            provider,
            metaApplications[provider],
            env.BETTER_AUTH_URL,
            env.WEB_ORIGIN,
          ),
        ),
      })),
    };
  }
  private runtime(provider: MetaConnectionProvider): MetaRuntimeConfiguration {
    const runtime = metaRuntimeConfiguration(
      provider,
      metaApplications[provider],
      env.BETTER_AUTH_URL,
      env.WEB_ORIGIN,
    );
    if (!runtime)
      throw new HttpException(
        {
          code: "meta_unavailable",
          message: "This Meta application is not configured on the server",
        },
        503,
      );
    // A mutable operator configuration must not change an in-flight client's confidential application.
    return { ...runtime, application: { ...runtime.application } };
  }
  private async verify(
    runtime: MetaRuntimeConfiguration,
    input: MetaAccountConnection,
    extraSecrets: readonly string[] = [],
  ) {
    const connection = validateMetaConnection(runtime, input);
    let proof: VerifyResult;
    if (runtime.provider === "facebook_page") {
      proof = await facebookPagePublisher.verify(
        facebookPagePublisher.credentialsSchema.parse(connection.credentials),
        { facebookPage: runtime.application },
      );
    } else {
      const publisher = getStagedPublisher(runtime.provider);
      if (!publisher)
        throw new HttpException(
          {
            code: "meta_unavailable",
            message: "This native Meta connection is unavailable on the server",
          },
          503,
        );
      proof = await publisher.verify(publisher.credentialsSchema.parse(connection.credentials), {
        threads: runtime.application,
      });
    }
    if (!proof.ok) {
      if (proof.indeterminate)
        throw new HttpException(
          {
            code: "meta_authorization_unavailable",
            message: "Meta publishing permission could not be checked; start again",
          },
          503,
        );
      throw badRequest(
        "meta_authorization_failed",
        "Meta did not confirm publishing permission for the selected account",
      );
    }
    if (proof.target !== connection.target)
      throw badRequest(
        "meta_authorization_failed",
        "Meta did not confirm the selected account identity",
      );
    const account = proof.account ?? connection.account;
    if (extraSecrets.some((secret) => secret && account.includes(secret)))
      throw new HttpException(
        {
          code: "meta_authorization_unavailable",
          message: "Meta returned an unusable account identity; start again",
        },
        503,
      );
    return validateMetaConnection(runtime, { ...connection, account });
  }
  private providerError(error: unknown): never {
    if (error instanceof MetaOAuthClientError) {
      if (error.kind === "unavailable" || error.kind === "configuration")
        throw new HttpException(
          {
            code: "meta_authorization_unavailable",
            message: "Meta authorization could not be verified; start again",
          },
          503,
        );
      throw badRequest(
        "meta_authorization_failed",
        "Meta authorization was not completed; start again from the brand",
      );
    }
    // Keep coded local refusals, never expose an unexpected provider/parser error's inputs.
    if (error instanceof HttpException) throw error;
    throw new HttpException(
      {
        code: "meta_authorization_unavailable",
        message: "Meta authorization could not be verified; start again",
      },
      503,
    );
  }

  async start(orgId: string, intent: MetaAuthorizationStart) {
    const runtime = this.runtime(intent.provider);
    const authorization = new MetaOAuthClient(
      intent.provider,
      runtime.application,
      env.META_GRAPH_API_VERSION,
    ).begin(runtime.redirectUri);
    await this.connections.start(orgId, intent, authorization, runtime);
    return metaAuthorizationStartedSchema.parse({
      provider: intent.provider,
      authorizationUrl: authorization.authorizationUrl,
    });
  }
  async complete(orgId: string, provider: MetaConnectionProvider, rawParameters: string) {
    const runtime = this.runtime(provider);
    const parameters = new URLSearchParams(rawParameters);
    const states = parameters.getAll("state");
    if (states.length !== 1 || !states[0])
      throw conflict("meta_authorization_invalid", "Start a new Meta connection request");
    const state = states[0];
    const request = await this.connections.consume(orgId, provider, state, runtime);
    try {
      const code = await new MetaOAuthClient(
        provider,
        runtime.application,
        env.META_GRAPH_API_VERSION,
      ).exchange({ parameters, expectedState: state, redirectUri: request.redirectUri });
      const result = await new MetaAccountClient(provider, runtime.application).connect(code);
      if ("pages" in result) {
        if (provider !== "facebook_page")
          throw badRequest(
            "meta_authorization_failed",
            "Meta did not confirm the requested account mode",
          );
        return await this.connections.stagePages(orgId, request.id, this.runtime(provider), result);
      }
      if (provider === "facebook_page")
        throw badRequest("meta_authorization_failed", "Choose a Facebook Page before connecting");
      const connection = await this.verify(runtime, result, [code.accessToken]);
      // Read current server lineage again after all network awaits. Persisted app/callback must still agree.
      return await this.connections.finish(orgId, request.id, this.runtime(provider), connection);
    } catch (error) {
      this.providerError(error);
    }
  }
  async selectPage(orgId: string, requestId: string, pageId: string) {
    const runtime = this.runtime("facebook_page");
    const selected = await this.connections.consumePage(orgId, requestId, pageId, runtime);
    try {
      const connection = await this.verify(runtime, selected.connection, selected.secrets);
      return await this.connections.finish(
        orgId,
        selected.requestId,
        this.runtime("facebook_page"),
        connection,
      );
    } catch (error) {
      this.providerError(error);
    }
  }
  disconnect(orgId: string, id: string, expectedGeneration: number) {
    return this.connections.disconnect(orgId, id, expectedGeneration);
  }
}
