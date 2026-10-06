import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import {
  type LinkedInAuthorizationStart,
  linkedinAuthorizationCompleteSchema,
  linkedinAuthorizationStartSchema,
  linkedinDisconnectSchema,
} from "@pubrick/shared";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { BrandScope } from "../org/brand-scope.decorator";
import { OrgId } from "../org/org-id.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { LinkedInConnectionsService } from "./linkedin-connections.service";

@Controller("channels/linkedin")
@UseGuards(ActiveOrgGuard)
export class LinkedInConnectionsController {
  constructor(private readonly connections: LinkedInConnectionsService) {}

  @Get("configuration")
  @BrandScope({ kind: "brand", source: "query", roles: "manager" })
  configuration(@OrgId() orgId: string) {
    return this.connections.configuration(orgId);
  }

  @Post("authorize")
  @BrandScope({ kind: "brand", source: "body", roles: "manager" })
  @HttpCode(200)
  start(
    @OrgId() orgId: string,
    @Body(new ZodValidationPipe(linkedinAuthorizationStartSchema)) body: LinkedInAuthorizationStart,
  ) {
    return this.connections.start(orgId, body);
  }

  @Post("complete")
  @BrandScope({ kind: "org", roles: "manager" })
  @HttpCode(200)
  complete(
    @OrgId() orgId: string,
    @Body(new ZodValidationPipe(linkedinAuthorizationCompleteSchema)) body: { parameters: string },
  ) {
    return this.connections.complete(orgId, body.parameters);
  }

  @Post(":id/disconnect")
  @BrandScope({ kind: "resource", resource: "channel", roles: "manager" })
  @HttpCode(204)
  disconnect(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(linkedinDisconnectSchema)) body: { expectedGeneration: number },
  ) {
    return this.connections.disconnect(orgId, id, body.expectedGeneration);
  }
}
