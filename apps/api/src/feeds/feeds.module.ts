import { Module } from "@nestjs/common";
import { ManagedFeedsController } from "./feeds.controller";
import { FeedsRepository } from "./feeds.repository";
import { PublicFeedsController } from "./public-feeds.controller";

@Module({
  controllers: [ManagedFeedsController, PublicFeedsController],
  providers: [FeedsRepository],
})
export class FeedsModule {}
