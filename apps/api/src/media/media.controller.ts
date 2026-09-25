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
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import {
  type MediaCoverRegenerate,
  type MediaCoverUpdate,
  type MediaGenerate,
  type MediaVideoUpdate,
  mediaCoverRegenerateSchema,
  mediaCoverUpdateSchema,
  mediaGenerateSchema,
  mediaVideoUpdateSchema,
} from "@pubrick/shared";
import type { Response } from "express";
import { z } from "zod";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { BrandScope } from "../org/brand-scope.decorator";
import { OrgId } from "../org/org-id.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { MEDIA_MAX_UPLOAD_BYTES, MediaRepository } from "./media.repository";
import { MediaImageService } from "./media-image.service";

const offsetSchema = z.coerce.number().int().min(0).max(100_000).default(0);

@Controller("media")
@UseGuards(ActiveOrgGuard)
@BrandScope({ kind: "brand", source: "query" })
export class MediaController {
  constructor(
    private readonly media: MediaRepository,
    private readonly images: MediaImageService,
  ) {}

  @Get()
  list(
    @OrgId() orgId: string,
    @Query("brandId", ParseUUIDPipe) brandId: string,
    @Query("offset", new ZodValidationPipe(offsetSchema)) offset: number,
  ) {
    return this.media.list(orgId, brandId, offset);
  }

  @Post()
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: MEDIA_MAX_UPLOAD_BYTES, files: 1 } }),
  )
  upload(
    @OrgId() orgId: string,
    @Query("brandId", ParseUUIDPipe) brandId: string,
    @UploadedFile() file?: { buffer: Buffer; originalname: string; mimetype: string },
  ) {
    return this.media.upload(orgId, brandId, file);
  }

  @Post("generate")
  @BrandScope({ kind: "brand", source: "body" })
  generate(
    @OrgId() orgId: string,
    @Body(new ZodValidationPipe(mediaGenerateSchema)) body: MediaGenerate,
  ) {
    return this.images.generate(orgId, body);
  }

  @Get(":id")
  @BrandScope({ kind: "resource", resource: "media" })
  get(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.media.get(orgId, id);
  }

  @Get(":id/file")
  @BrandScope({ kind: "resource", resource: "media" })
  async file(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Res() response: Response,
  ): Promise<void> {
    const asset = await this.media.fileForStream(orgId, id);
    response.setHeader("Content-Type", asset.mimeType);
    response.setHeader("Content-Disposition", "inline");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "private, max-age=300");
    await new Promise<void>((resolve) => {
      response.sendFile(asset.path, { dotfiles: "allow" }, (error) => {
        if (error && !response.headersSent) response.status(404).end();
        resolve();
      });
    });
  }

  @Delete(":id")
  @BrandScope({ kind: "resource", resource: "media" })
  @HttpCode(204)
  async delete(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string): Promise<void> {
    await this.media.delete(orgId, id);
  }

  @Patch("posts/:id/cover")
  @BrandScope({ kind: "resource", resource: "content" })
  attach(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(mediaCoverUpdateSchema)) body: MediaCoverUpdate,
  ) {
    return this.media.attach(orgId, id, body.mediaId);
  }

  @Post("posts/:id/cover/regenerate")
  @BrandScope({ kind: "resource", resource: "content" })
  regenerateCover(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(mediaCoverRegenerateSchema)) body: MediaCoverRegenerate,
  ) {
    return this.images.regenerateCover(orgId, id, body);
  }

  @Patch("posts/:id/video")
  @BrandScope({ kind: "resource", resource: "content" })
  attachVideo(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(mediaVideoUpdateSchema)) body: MediaVideoUpdate,
  ) {
    return this.media.attachVideo(orgId, id, body.mediaId);
  }
}
