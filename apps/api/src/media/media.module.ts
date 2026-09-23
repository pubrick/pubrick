import { Module } from "@nestjs/common";
import { MediaController } from "./media.controller";
import { MediaRepository } from "./media.repository";

@Module({ controllers: [MediaController], providers: [MediaRepository] })
export class MediaModule {}
