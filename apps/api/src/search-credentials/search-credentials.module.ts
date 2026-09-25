import { Module } from "@nestjs/common";
import { SearchCredentialsController } from "./search-credentials.controller";
import { SearchCredentialsRepository } from "./search-credentials.repository";

@Module({
  controllers: [SearchCredentialsController],
  providers: [SearchCredentialsRepository],
  exports: [SearchCredentialsRepository],
})
export class SearchCredentialsModule {}
