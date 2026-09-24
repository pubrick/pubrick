import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { type SourceExtractionRequest, sourceExtractionRequestSchema } from "@pubrick/shared";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { BrandScope } from "../org/brand-scope.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { SourceExtractionService } from "./source-extraction.service";

@Controller("source-extraction")
@UseGuards(ActiveOrgGuard)
@BrandScope({ kind: "org", roles: "member" })
export class SourceExtractionController {
  constructor(private readonly sources: SourceExtractionService) {}

  @Post()
  @HttpCode(200)
  extract(
    @Body(new ZodValidationPipe(sourceExtractionRequestSchema)) body: SourceExtractionRequest,
  ) {
    return this.sources.extract(body.url);
  }
}
