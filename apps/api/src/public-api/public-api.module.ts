import { Module } from "@nestjs/common";
import { ContentModule } from "../content/content.module";
import { RunsModule } from "../runs/runs.module";
import { ApiKeyGuard } from "./api-key.guard";
import { ApiKeysController } from "./api-keys.controller";
import { ApiKeysRepository } from "./api-keys.repository";
import { ApiKeysManagerGuard } from "./api-keys-manager.guard";
import { PublicContentController } from "./public-content.controller";
import { PublicContentRepository } from "./public-content.repository";
import { PublicContentV2Controller } from "./public-content-v2.controller";
import { PublicPublicationController } from "./public-publication.controller";
import { PublicPublicationRepository } from "./public-publication.repository";
import { PublicRateLimitGuard, PublicRateLimitService } from "./public-rate-limit.service";
import { PublicRunsV2Controller } from "./public-runs-v2.controller";
import { PublicWriteRepository } from "./public-write.repository";

@Module({
  imports: [ContentModule, RunsModule],
  controllers: [
    PublicContentV2Controller,
    PublicRunsV2Controller,
    ApiKeysController,
    PublicContentController,
    PublicPublicationController,
  ],
  providers: [
    PublicWriteRepository,
    PublicRateLimitService,
    PublicRateLimitGuard,
    ApiKeysRepository,
    ApiKeysManagerGuard,
    ApiKeyGuard,
    PublicContentRepository,
    PublicPublicationRepository,
  ],
})
export class PublicApiModule {}
