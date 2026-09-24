import { Module } from "@nestjs/common";
import { MediaModule } from "../media/media.module";
import { ManagedFeedsController } from "./feeds.controller";
import { FeedsRepository } from "./feeds.repository";
import { PublicFeedsController } from "./public-feeds.controller";

@Module({
  imports: [MediaModule],
  controllers: [ManagedFeedsController, PublicFeedsController],
  providers: [FeedsRepository],
})
export class FeedsModule {}
