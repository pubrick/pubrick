import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { HostedAdmissionController } from "./hosted-admission.controller";
import { HostedAdmissionService } from "./hosted-admission.service";

const service = {
  create: vi.fn(async () => ({ organizationId: "committed-org" })),
  invite: vi.fn(async () => ({
    invitationId: "committed-invite",
    email: "recipient@example.test",
    expiresAt: new Date("2030-01-03T00:00:00Z"),
  })),
  cancel: vi.fn(async () => undefined),
};
@Module({
  controllers: [HostedAdmissionController],
  providers: [{ provide: HostedAdmissionService, useValue: service }],
})
class TestModule {}

describe("hosted workspace HTTP contracts", () => {
  let app: NestExpressApplication;
  beforeAll(async () => {
    app = await NestFactory.create<NestExpressApplication>(TestModule, { logger: false });
    app.use(
      (
        req: { session?: unknown; headers: Record<string, unknown> },
        _res: unknown,
        next: () => void,
      ) => {
        if (req.headers["x-test-session"] === "verified")
          req.session = { user: { id: "server-user" }, session: { id: "server-session" } };
        next();
      },
    );
    app.setGlobalPrefix("api");
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
  });
  it("takes actor identity from the guarded session and returns the committed workspace ID", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/hosted-admission/create")
      .set("x-test-session", "verified")
      .send({ name: "Workspace", slug: "workspace" });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ id: "committed-org" });
    expect(service.create).toHaveBeenCalledWith(
      { userId: "server-user", sessionId: "server-session" },
      { name: "Workspace", slug: "workspace" },
    );
  });
  it("refuses body-supplied actor identity rather than overriding the guarded actor", async () => {
    const before = service.create.mock.calls.length;
    const response = await request(app.getHttpServer())
      .post("/api/hosted-admission/create")
      .set("x-test-session", "verified")
      .send({ name: "Workspace", slug: "workspace", userId: "attacker" });
    expect(response.status).toBe(400);
    expect(service.create.mock.calls).toHaveLength(before);
  });
  it("does not call the admission service without a server session", async () => {
    const before = service.create.mock.calls.length;
    const response = await request(app.getHttpServer())
      .post("/api/hosted-admission/create")
      .send({ name: "Workspace", slug: "workspace" });
    expect(response.status).toBe(401);
    expect(service.create.mock.calls).toHaveLength(before);
  });
  it("returns persisted invitation facts required by the Settings confirmation", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/hosted-admission/invite")
      .set("x-test-session", "verified")
      .send({
        orgId: "selected-org",
        email: "recipient@example.test",
        role: "member",
        locale: "ru",
      });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      id: "committed-invite",
      email: "recipient@example.test",
      expiresAt: "2030-01-03T00:00:00.000Z",
    });
  });
  it("returns a JSON acknowledgment for a void mutation", async () => {
    const response = await request(app.getHttpServer())
      .post("/api/hosted-admission/cancel")
      .set("x-test-session", "verified")
      .send({ orgId: "selected-org", invitationId: "committed-invite" });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
  });
});
