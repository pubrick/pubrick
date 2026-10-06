import { Module } from "@nestjs/common";
import { AiCredentialsModule } from "../ai-credentials/ai-credentials.module";
import { GeminiImageCaller } from "./gemini-image.caller";
import { MediaController } from "./media.controller";
import { MediaRepository } from "./media.repository";
import { MediaImageService } from "./media-image.service";
import { MetaMediaController } from "./meta-media.controller";
import { MetaMediaRepository } from "./meta-media.repository";

@Module({
  imports: [AiCredentialsModule],
  controllers: [MediaController, MetaMediaController],
  providers: [MediaRepository, MediaImageService, GeminiImageCaller, MetaMediaRepository],
  exports: [MediaRepository, MediaImageService],
})
export class MediaModule {}
