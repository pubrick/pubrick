import { Module } from "@nestjs/common";
import { ApiKeyGuard } from "./api-key.guard";
import { ApiKeysController } from "./api-keys.controller";
import { ApiKeysRepository } from "./api-keys.repository";
import { ApiKeysManagerGuard } from "./api-keys-manager.guard";
import { PublicContentController } from "./public-content.controller";
import { PublicContentRepository } from "./public-content.repository";
import { PublicPublicationController } from "./public-publication.controller";
import { PublicPublicationRepository } from "./public-publication.repository";

@Module({
  controllers: [ApiKeysController, PublicContentController, PublicPublicationController],
  providers: [
    ApiKeysRepository,
    ApiKeysManagerGuard,
    ApiKeyGuard,
    PublicContentRepository,
    PublicPublicationRepository,
  ],
})
export class PublicApiModule {}
