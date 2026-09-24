import { Module } from "@nestjs/common";
import { AiCredentialsModule } from "../ai-credentials/ai-credentials.module";
import { GeminiImageCaller } from "./gemini-image.caller";
import { MediaController } from "./media.controller";
import { MediaRepository } from "./media.repository";
import { MediaImageService } from "./media-image.service";

@Module({
  imports: [AiCredentialsModule],
  controllers: [MediaController],
  providers: [MediaRepository, MediaImageService, GeminiImageCaller],
  exports: [MediaRepository],
})
export class MediaModule {}
