import { Body, Controller, Delete, Get, HttpCode, Put, UseGuards } from "@nestjs/common";
import { type SearchCredentialUpsert, searchCredentialUpsertSchema } from "@pubrick/shared";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { BrandScope } from "../org/brand-scope.decorator";
import { OrgId } from "../org/org-id.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { SearchCredentialsRepository } from "./search-credentials.repository";

@Controller("search-credentials")
@UseGuards(ActiveOrgGuard)
@BrandScope({ kind: "org", roles: "manager" })
export class SearchCredentialsController {
  constructor(private readonly credentials: SearchCredentialsRepository) {}

  @Get()
  get(@OrgId() orgId: string) {
    return this.credentials.get(orgId);
  }

  @Put()
  upsert(
    @OrgId() orgId: string,
    @Body(new ZodValidationPipe(searchCredentialUpsertSchema)) body: SearchCredentialUpsert,
  ) {
    return this.credentials.upsert(orgId, body);
  }

  @Delete()
  @HttpCode(204)
  async delete(@OrgId() orgId: string): Promise<void> {
    await this.credentials.delete(orgId);
  }
}
