import { Controller, Module, Post, Req } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installBillingWebhookParser } from "../billing/webhook-parser";
import { installPublicWriteParser } from "./public-write-parser";

let received = 0;
@Controller()
class Probe {
  @Post("v2/content") content(@Req() req: { body: unknown }) {
    received++;
    return req.body;
  }
  @Post("billing/webhook") webhook(@Req() req: { rawBody?: Buffer }) {
    return { hex: req.rawBody?.toString("hex") };
  }
}
@Module({ controllers: [Probe] })
class ProbeModule {}
describe("production-compatible public JSON admission", () => {
  let app: NestExpressApplication;
  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(ProbeModule, {
      bodyParser: false,
      rawBody: true,
      logger: false,
    });
    installBillingWebhookParser(app);
    installPublicWriteParser(app);
    app.setGlobalPrefix("api");
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
  });
  it("parses public JSON while preserving signed webhook bytes", async () => {
    expect(
      (await request(app.getHttpServer()).post("/api/v2/content").send({ body: "fixture" })).body,
    ).toEqual({ body: "fixture" });
    const bytes = '{ "fixture": 1 }\n';
    expect(
      (
        await request(app.getHttpServer())
          .post("/api/billing/webhook")
          .set("Content-Type", "application/json")
          .send(bytes)
      ).body.hex,
    ).toBe(Buffer.from(bytes).toString("hex"));
  });
  it("refuses oversized and compressed bodies before the domain receives them, including trailing slash", async () => {
    const before = received;
    expect(
      (
        await request(app.getHttpServer())
          .post("/api/v2/content/")
          .set("Content-Type", "application/json")
          .send(JSON.stringify({ body: "x".repeat(1024 * 1024) }))
      ).status,
    ).toBe(413);
    expect(
      (
        await request(app.getHttpServer())
          .post("/api/v2/content")
          .set("Content-Type", "application/json")
          .set("Content-Encoding", "gzip")
          .send("{}")
      ).status,
    ).toBe(415);
    expect(received).toBe(before);
  });
});
