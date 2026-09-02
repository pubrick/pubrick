import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  type ChannelCreate,
  type ChannelUpdate,
  channelCreateSchema,
  channelUpdateSchema,
} from "@pubrick/shared";
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

  /**
   * Rename a channel, or install new credentials for it.
   *
   * The reason this route exists: platform tokens get revoked, and without it
   * the only way to install a new one was DELETE + POST — which cascaded every
   * adaptation the channel had, scheduled posts included. Returns the same
   * public columns as every other route here; the ciphertext it writes is never
   * part of a response.
   */
  @Patch(":id")
  update(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(channelUpdateSchema)) body: ChannelUpdate,
  ) {
    return this.channels.update(orgId, id, body);
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
