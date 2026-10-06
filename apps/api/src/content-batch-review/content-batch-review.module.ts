import { Module } from "@nestjs/common";
import { ContentModule } from "../content/content.module";
import { ContentBatchReviewController } from "./content-batch-review.controller";
import { ContentBatchReviewRepository } from "./content-batch-review.repository";

@Module({
  imports: [ContentModule],
  controllers: [ContentBatchReviewController],
  providers: [ContentBatchReviewRepository],
})
export class ContentBatchReviewModule {}
