import { Global, Module } from "@nestjs/common";
import { BrandAccessController } from "./brand-access.controller";
import { BrandAccessRepository } from "./brand-access.repository";
import { BrandAccessService } from "./brand-access.service";
import { BrandAccessManagerGuard } from "./brand-access-manager.guard";

@Global()
@Module({
  controllers: [BrandAccessController],
  providers: [BrandAccessRepository, BrandAccessService, BrandAccessManagerGuard],
  exports: [BrandAccessRepository],
})
export class BrandAccessModule {}
