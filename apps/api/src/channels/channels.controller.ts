import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { type ChannelCreate, channelCreateSchema } from "@pubrick/shared";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { OrgId } from "../org/org-id.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { ChannelsRepository } from "./channels.repository";

@Controller("channels")
@UseGuards(ActiveOrgGuard)
export class ChannelsController {
  constructor(private readonly channels: ChannelsRepository) {}

  @Get()
  list(
    @OrgId() orgId: string,
    @Query("brandId", new ParseUUIDPipe({ optional: true })) brandId?: string,
  ) {
    return this.channels.list(orgId, brandId);
  }

  @Post()
  create(
    @OrgId() orgId: string,
    @Body(new ZodValidationPipe(channelCreateSchema)) body: ChannelCreate,
  ) {
    return this.channels.create(orgId, body);
  }

  @Delete(":id")
  delete(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.channels.delete(orgId, id);
  }

  @Post(":id/test")
  @HttpCode(200)
  test(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.channels.verify(orgId, id);
  }
}
