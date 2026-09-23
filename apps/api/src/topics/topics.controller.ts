import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  type NewsFeedback,
  newsFeedbackSchema,
  type TopicCreate,
  type TopicRun,
  type TopicUpdate,
  topicCreateSchema,
  topicRunSchema,
  topicUpdateSchema,
} from "@pubrick/shared";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { OrgId } from "../org/org-id.decorator";
import { ZodValidationPipe } from "../validation.pipe";
import { TopicsRepository } from "./topics.repository";

@Controller("topics")
@UseGuards(ActiveOrgGuard)
export class TopicsController {
  constructor(private readonly topics: TopicsRepository) {}

  @Get()
  list(@OrgId() orgId: string, @Query("brandId", ParseUUIDPipe) brandId: string) {
    return this.topics.list(orgId, brandId);
  }

  @Post()
  create(
    @OrgId() orgId: string,
    @Body(new ZodValidationPipe(topicCreateSchema)) body: TopicCreate,
  ) {
    return this.topics.create(orgId, body);
  }

  @Post("from-news/:newsItemId")
  fromNews(
    @OrgId() orgId: string,
    @Query("brandId", ParseUUIDPipe) brandId: string,
    @Param("newsItemId", ParseUUIDPipe) newsItemId: string,
  ) {
    return this.topics.fromNews(orgId, brandId, newsItemId);
  }

  @Patch("news/:newsItemId/feedback")
  feedback(
    @OrgId() orgId: string,
    @Query("brandId", ParseUUIDPipe) brandId: string,
    @Param("newsItemId", ParseUUIDPipe) newsItemId: string,
    @Body(new ZodValidationPipe(newsFeedbackSchema)) body: NewsFeedback,
  ) {
    return this.topics.feedback(orgId, brandId, newsItemId, body);
  }

  @Patch(":id")
  update(
    @OrgId() orgId: string,
    @Query("brandId", ParseUUIDPipe) brandId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(topicUpdateSchema)) body: TopicUpdate,
  ) {
    return this.topics.update(orgId, brandId, id, body);
  }

  @Delete(":id")
  delete(
    @OrgId() orgId: string,
    @Query("brandId", ParseUUIDPipe) brandId: string,
    @Param("id", ParseUUIDPipe) id: string,
  ) {
    return this.topics.delete(orgId, brandId, id);
  }

  @Post(":id/run")
  run(
    @OrgId() orgId: string,
    @Query("brandId", ParseUUIDPipe) brandId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(topicRunSchema)) body: TopicRun,
  ) {
    return this.topics.run(orgId, brandId, id, body);
  }
}
