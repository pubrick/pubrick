import { HttpException, Injectable } from "@nestjs/common";
import { linkedinPublisher } from "@pubrick/integrations";
import {
  type LinkedInAuthorizationStart,
  linkedinAuthorizationCompletedSchema,
} from "@pubrick/shared";
import { badRequest, conflict } from "../api-error";
import { env, linkedinApplication } from "../env";
import { LinkedInConnectionsRepository } from "./linkedin-connections.repository";
import { LinkedInOAuthClient, LinkedInOAuthClientError } from "./linkedin-oauth-client";
import { linkedinRuntimeConfiguration } from "./linkedin-runtime-config";

@Injectable()
export class LinkedInConnectionsService {
  constructor(private readonly connections: LinkedInConnectionsRepository) {}

  configuration(_orgId: string) {
    return {
      available: Boolean(
        linkedinRuntimeConfiguration(linkedinApplication, env.BETTER_AUTH_URL, env.WEB_ORIGIN),
      ),
    };
  }
  private runtime() {
    const runtime = linkedinRuntimeConfiguration(
      linkedinApplication,
      env.BETTER_AUTH_URL,
      env.WEB_ORIGIN,
    );
    if (!runtime)
      throw new HttpException(
        { code: "linkedin_unavailable", message: "LinkedIn is not configured on this server" },
        503,
      );
    return runtime;
  }
  async start(orgId: string, intent: LinkedInAuthorizationStart) {
    const runtime = this.runtime();
    const authorization = new LinkedInOAuthClient(runtime.application).begin(runtime.redirectUri);
    await this.connections.start(orgId, intent, authorization);
    // Persistence is committed before this URL can leave the server.
    return { authorizationUrl: authorization.authorizationUrl };
  }
  async complete(orgId: string, rawParameters: string) {
    const runtime = this.runtime();
    const parameters = new URLSearchParams(rawParameters);
    const states = parameters.getAll("state");
    if (states.length !== 1)
      throw conflict("linkedin_authorization_invalid", "Start a new LinkedIn connection request");
    const request = await this.connections.consume(orgId, states[0] as string);
    try {
      const connection = await new LinkedInOAuthClient(runtime.application).exchange({
        expectedState: states[0] as string,
        expectedNonce: this.connections.nonce(orgId, request),
        parameters,
        redirectUri: runtime.redirectUri,
      });
      const proof = await linkedinPublisher.verify(connection.credentials, {
        linkedin: runtime.application,
      });
      if (!proof.ok) {
        if (proof.indeterminate)
          throw new HttpException(
            {
              code: "linkedin_authorization_unavailable",
              message: "LinkedIn publishing permission could not be checked; start again",
            },
            503,
          );
        throw badRequest(
          "linkedin_authorization_failed",
          "LinkedIn did not confirm personal publishing permission for this application",
        );
      }
      if (proof.target !== connection.credentials.authorUrn)
        throw badRequest(
          "linkedin_authorization_failed",
          "LinkedIn did not confirm the authorized personal account",
        );
      const channelId = await this.connections.finish(orgId, request, connection);
      return linkedinAuthorizationCompletedSchema.parse({
        brandId: request.brandId,
        channelId,
        locale: request.locale,
      });
    } catch (error) {
      if (error instanceof LinkedInOAuthClientError) {
        if (error.kind === "unavailable" || error.kind === "configuration")
          throw new HttpException(
            {
              code: "linkedin_authorization_unavailable",
              message: "LinkedIn authorization could not be verified; start again",
            },
            503,
          );
        throw badRequest(
          "linkedin_authorization_failed",
          "LinkedIn authorization was not completed; start again from the brand",
        );
      }
      throw error;
    }
  }
  disconnect(orgId: string, id: string, expectedGeneration: number) {
    return this.connections.disconnect(orgId, id, expectedGeneration);
  }
}
