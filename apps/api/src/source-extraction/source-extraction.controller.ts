import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { type SourceExtractionRequest, sourceExtractionRequestSchema } from "@pubrick/shared";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { ZodValidationPipe } from "../validation.pipe";
import { SourceExtractionService } from "./source-extraction.service";

@Controller("source-extraction")
@UseGuards(ActiveOrgGuard)
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
