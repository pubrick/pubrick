import { Module } from "@nestjs/common";
import { MediaModule } from "../media/media.module";
import { ClientReviewController } from "./client-review.controller";
import { ClientReviewRepository } from "./client-review.repository";
import { GuestClientReviewController } from "./guest-client-review.controller";

@Module({
  imports: [MediaModule],
  controllers: [ClientReviewController, GuestClientReviewController],
  providers: [ClientReviewRepository],
})
export class ClientReviewModule {}
