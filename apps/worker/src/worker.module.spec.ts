import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { GenerateService } from "./generate/generate.service";
import { PublishService } from "./publish/publish.service";
import { QueueService } from "./queue.service";
import { WorkerModule } from "./worker.module";

/**
 * Every other worker spec constructs PublishService with a plain `new`,
 * bypassing Nest's DI entirely — none of them would have caught the real
 * `main.ts` -> NestFactory.createApplicationContext(WorkerModule) boot path
 * throwing UnknownDependenciesException for PublishService's non-provider
 * constructor params (lookup/baseUrl/markPublishedRetryDelayMs, fixed with
 * @Optional() — see the comment on that constructor). This test exercises
 * that exact path: Test.createTestingModule + compile() runs the same
 * constructor-dependency resolution Nest's real injector does. No live DB
 * needed — vitest.setup.ts seeds a syntactically valid DATABASE_URL and the
 * pg.Pool it backs never connects until a query runs.
 */
describe("WorkerModule", () => {
  it("compiles through Nest's real DI and resolves every service main.ts needs", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    expect(moduleRef.get(PublishService)).toBeInstanceOf(PublishService);
    // GenerateService has the same @Optional() test seams — a model factory and a
    // retry delay — and would fail to boot for the same reason without them. And
    // QueueService now depends on both services, so resolving it is what proves
    // main.ts's `app.get(QueueService)` still works.
    expect(moduleRef.get(GenerateService)).toBeInstanceOf(GenerateService);
    expect(moduleRef.get(QueueService)).toBeInstanceOf(QueueService);
    await moduleRef.close();
  });
});
