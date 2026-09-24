import { Module } from "@nestjs/common";
import { MediaModule } from "../media/media.module";
import { ClientReviewController, GuestClientReviewController } from "./client-review.controller";
import { ClientReviewRepository } from "./client-review.repository";

@Module({
  imports: [MediaModule],
  controllers: [ClientReviewController, GuestClientReviewController],
  providers: [ClientReviewRepository],
})
export class ClientReviewModule {}
