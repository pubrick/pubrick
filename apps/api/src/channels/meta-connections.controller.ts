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
  type MetaAuthorizationStart,
  type MetaConnectionProvider,
  metaAuthorizationCompleteSchema,
  metaAuthorizationStartSchema,
  metaDisconnectSchema,
  metaPageSelectionSchema,
} from "@pubrick/shared";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { BrandScope } from "../org/brand-scope.decorator";
import { OrgId } from "../org/org-id.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { MetaConnectionsService } from "./meta-connections.service";

@Controller("channels/meta")
@UseGuards(ActiveOrgGuard)
export class MetaConnectionsController {
  constructor(private readonly connections: MetaConnectionsService) {}

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
    @Body(new ZodValidationPipe(metaAuthorizationStartSchema)) body: MetaAuthorizationStart,
  ) {
    return this.connections.start(orgId, body);
  }
  @Post("complete")
  @BrandScope({ kind: "org", roles: "manager" })
  @HttpCode(200)
  complete(
    @OrgId() orgId: string,
    @Body(new ZodValidationPipe(metaAuthorizationCompleteSchema)) body: {
      provider: MetaConnectionProvider;
      parameters: string;
    },
  ) {
    return this.connections.complete(orgId, body.provider, body.parameters);
  }
  @Post("select-page")
  @BrandScope({ kind: "org", roles: "manager" })
  @HttpCode(200)
  selectPage(
    @OrgId() orgId: string,
    @Body(new ZodValidationPipe(metaPageSelectionSchema)) body: {
      requestId: string;
      pageId: string;
    },
  ) {
    return this.connections.selectPage(orgId, body.requestId, body.pageId);
  }
  @Post(":id/disconnect")
  @BrandScope({ kind: "resource", resource: "channel", roles: "manager" })
  @HttpCode(204)
  disconnect(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(metaDisconnectSchema)) body: { expectedGeneration: number },
  ) {
    return this.connections.disconnect(orgId, id, body.expectedGeneration);
  }
}
