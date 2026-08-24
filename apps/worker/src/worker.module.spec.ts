import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { PublishService } from "./publish/publish.service";
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
  it("compiles through Nest's real DI and resolves PublishService", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    expect(moduleRef.get(PublishService)).toBeInstanceOf(PublishService);
    await moduleRef.close();
  });
});
