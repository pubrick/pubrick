import { Module } from "@nestjs/common";
import { MediaCleanupRepository } from "./media-cleanup.repository";
import { MediaCleanupService } from "./media-cleanup.service";
@Module({
  providers: [MediaCleanupRepository, MediaCleanupService],
  exports: [MediaCleanupService],
})
export class MediaCleanupModule {}
