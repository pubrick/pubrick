import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HealthModule } from "./health.module";

describe("GET /api/health", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [HealthModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api");
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns ok with a version", async () => {
    const res = await request(app.getHttpServer()).get("/api/health").expect(200);
    expect(res.body.status).toBe("ok");
    expect(typeof res.body.version).toBe("string");
  });
});
