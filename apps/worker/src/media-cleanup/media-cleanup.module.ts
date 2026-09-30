import { Module } from "@nestjs/common";
import { MediaCleanupLifecycle } from "./media-cleanup.lifecycle";
import { MediaCleanupRepository } from "./media-cleanup.repository";
import { MediaCleanupService } from "./media-cleanup.service";
@Module({
  providers: [MediaCleanupRepository, MediaCleanupService, MediaCleanupLifecycle],
  exports: [MediaCleanupService],
})
export class MediaCleanupModule {}
