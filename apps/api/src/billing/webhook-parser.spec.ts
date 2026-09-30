import { Controller, Module, Post, Req } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { webhookInput } from "./billing.contracts";
import { installBillingWebhookParser } from "./webhook-parser";

@Controller("billing")
class WebhookProbe {
  @Post("webhook")
  receive(@Req() input: { rawBody?: unknown; headers: Record<string, unknown> }) {
    return { hex: webhookInput(input).bytes.toString("hex") };
  }
}
@Module({ controllers: [WebhookProbe] })
class ParserTestModule {}

describe("native billing webhook body parser", () => {
  let app: NestExpressApplication;
  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(ParserTestModule, {
      bodyParser: false,
      rawBody: true,
      logger: false,
    });
    installBillingWebhookParser(app);
    app.setGlobalPrefix("api");
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
  });
  it("preserves whitespace and Unicode bytes before controller signature verification", async () => {
    const bytes = Buffer.from('{ "name": "é",\n "value": 1 }\n');
    const response = await request(app.getHttpServer())
      .post("/api/billing/webhook")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "fixture-signature")
      .send(bytes.toString("utf8"));
    expect(response.status).toBe(201);
    expect(response.body.hex).toBe(bytes.toString("hex"));
  });
  it("refuses oversized signed payloads before a controller receives them", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/billing/webhook")
      .set("Content-Type", "application/octet-stream")
      .set("stripe-signature", "fixture-signature")
      .send(Buffer.alloc(1024 * 1024 + 1, 120));
    expect(response.status).toBe(413);
  });
  it("refuses compressed payloads rather than changing the bytes being verified", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/billing/webhook")
      .set("Content-Type", "application/json")
      .set("Content-Encoding", "gzip")
      .send("compressed");
    expect(response.status).toBe(415);
  });
});
