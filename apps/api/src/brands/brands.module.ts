import { Module } from "@nestjs/common";
import { AiCredentialsModule } from "../ai-credentials/ai-credentials.module";
import { BrandImportCaller } from "./brand-import.caller";
import { BrandImportService } from "./brand-import.service";
import { BrandsController } from "./brands.controller";
import { BrandsRepository } from "./brands.repository";

@Module({
  imports: [AiCredentialsModule],
  controllers: [BrandsController],
  providers: [BrandsRepository, BrandImportService, BrandImportCaller],
})
export class BrandsModule {}
