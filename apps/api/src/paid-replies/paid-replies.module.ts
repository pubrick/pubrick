import { Module } from "@nestjs/common";
import { PaidRepliesController } from "./paid-replies.controller";
import { PaidRepliesRepository } from "./paid-replies.repository";

@Module({ controllers: [PaidRepliesController], providers: [PaidRepliesRepository] })
export class PaidRepliesModule {}
