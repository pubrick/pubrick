import { Injectable } from "@nestjs/common";
import type { BrandAccessReplace } from "@pubrick/shared";
import { BrandAccessRepository } from "./brand-access.repository";

@Injectable()
export class BrandAccessService {
  constructor(private readonly access: BrandAccessRepository) {}

  list(orgId: string, brandId: string) {
    return this.access.list(orgId, brandId);
  }

  replace(orgId: string, brandId: string, body: BrandAccessReplace) {
    return this.access.replace(orgId, brandId, body.memberIds);
  }
}
