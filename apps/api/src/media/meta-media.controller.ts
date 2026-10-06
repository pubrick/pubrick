import { Controller, Get, Param, Res } from "@nestjs/common";
import { AllowAnonymous } from "@thallesp/nestjs-better-auth";
import type { Response } from "express";
import { MetaMediaRepository } from "./meta-media.repository";

/** Meta fetches a purpose-bound expiring worker capability, never a workspace media URL. */
@Controller("media/meta/:orgId/:token")
@AllowAnonymous()
export class MetaMediaController {
  constructor(private readonly media: MetaMediaRepository) {}

  @Get()
  async file(
    @Param("orgId") orgId: string,
    @Param("token") token: string,
    @Res() response: Response,
  ): Promise<void> {
    const bytes = await this.media.file(orgId, token);
    response.setHeader("Content-Type", "image/jpeg");
    response.setHeader("Content-Disposition", "inline");
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Robots-Tag", "noindex, nofollow");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.status(200).send(bytes);
  }
}
