import { Module } from "@nestjs/common";
import { QueueModule } from "../queue/queue.module";
import { ClaimReviewController } from "./claim-review.controller";
import { ClaimReviewRepository } from "./claim-review.repository";

@Module({
  imports: [QueueModule],
  controllers: [ClaimReviewController],
  providers: [ClaimReviewRepository],
})
export class ClaimReviewModule {}
