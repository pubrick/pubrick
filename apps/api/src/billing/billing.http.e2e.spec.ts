import type { ExecutionContext, INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HOSTED_BROWSER_ORIGIN,
  HostedBrowserGuard,
} from "../hosted-admission/hosted-browser.guard";
import { ActiveOrgGuard } from "../org/active-org.guard";
import { BillingController } from "./billing.controller";
import { BillingService } from "./billing.service";
import { PublicBillingController } from "./public-billing.controller";

// Authentication belongs to the real-session tiers. This native HTTP contract
// supplies a server-resolved actor without importing auth/database singletons;
// the trusted-origin guard, routes, body pipes and parameter decorators are real.
vi.mock("../org/active-org.guard", () => ({
  ActiveOrgGuard: class ActiveOrgGuard {
    canActivate() {
      return false;
    }
  },
}));

const origin = "https://hosted.example.test";
const actor = { orgId: "server_org", userId: "server_user" };
const status = {
  mode: "test",
  funding: "byok",
  status: "unconfigured",
  plan: null,
  limits: null,
  usage: { seats: 1, brands: 0, channels: 0, mediaBytes: 0, concurrentJobs: 0 },
  accessUntil: null,
  cancelAtPeriodEnd: false,
  canManage: true,
  checkoutAvailable: true,
  portalAvailable: false,
};
const billing = {
  status: vi.fn(async () => status),
  start: vi.fn(async () => ({ id: "cs_contract", url: "https://sandbox.example.test/checkout" })),
  portal: vi.fn(async () => ({ url: "https://sandbox.example.test/portal" })),
  plans: vi.fn(() => []),
  webhook: vi.fn(async () => ({ received: true })),
};

describe("billing native HTTP boundary without database or external SDK", () => {
  let app: INestApplication;
  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [BillingController, PublicBillingController],
      providers: [
        { provide: BillingService, useValue: billing },
        { provide: HOSTED_BROWSER_ORIGIN, useValue: origin },
        HostedBrowserGuard,
      ],
    })
      .overrideGuard(ActiveOrgGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          const req = context.switchToHttp().getRequest();
          req.orgId = actor.orgId;
          req.session = { user: { id: actor.userId } };
          return true;
        },
      })
      .compile();
    // This small router uses Nest's own raw-body capture. The production
    // bodyParser:false integration has a separate application-level acceptance gate.
    app = moduleRef.createNestApplication({ rawBody: true });
    app.setGlobalPrefix("api");
    await app.init();
    await app.listen(0, "127.0.0.1");
  });
  beforeEach(() => vi.clearAllMocks());
  afterAll(async () => {
    await app?.close();
  });

  it("serves the UI's /api/billing/status endpoint with the server actor", async () => {
    const response = await request(app.getHttpServer())
      .get("/api/billing/status")
      .set("x-org-id", "caller_org")
      .set("x-user-id", "caller_user")
      .expect(200);
    expect(response.body).toEqual(status);
    expect(billing.status).toHaveBeenCalledExactlyOnceWith(actor.orgId, actor.userId);
    await request(app.getHttpServer()).get("/api/billing").expect(404);
    expect(billing.status).toHaveBeenCalledTimes(1);
  });

  it("accepts trusted JSON checkout and portal requests with only server-owned identities", async () => {
    await request(app.getHttpServer())
      .post("/api/billing/checkout")
      .set("Origin", origin)
      .set("Sec-Fetch-Site", "same-origin")
      .send({ planId: "operator_plan", locale: "ru" })
      .expect(200);
    expect(billing.start).toHaveBeenCalledExactlyOnceWith(
      actor.orgId,
      actor.userId,
      "operator_plan",
      "ru",
    );
    await request(app.getHttpServer())
      .post("/api/billing/portal")
      .set("Origin", origin)
      .send({ locale: "en" })
      .expect(200);
    expect(billing.portal).toHaveBeenCalledExactlyOnceWith(actor.orgId, actor.userId, "en");
  });

  it.each(["checkout", "portal"])(
    "refuses untrusted or form %s before the mocked SDK service",
    async (path) => {
      const body =
        path === "checkout" ? { planId: "operator_plan", locale: "en" } : { locale: "en" };
      await request(app.getHttpServer())
        .post(`/api/billing/${path}`)
        .set("Origin", "https://foreign.example.test")
        .send(body)
        .expect(403);
      await request(app.getHttpServer())
        .post(`/api/billing/${path}`)
        .set("Origin", origin)
        .set("Sec-Fetch-Site", "cross-site")
        .send(body)
        .expect(403);
      await request(app.getHttpServer()).post(`/api/billing/${path}`).send(body).expect(403);
      await request(app.getHttpServer())
        .post(`/api/billing/${path}`)
        .set("Origin", origin)
        .type("form")
        .send(body)
        .expect(403);
      expect(billing.start).not.toHaveBeenCalled();
      expect(billing.portal).not.toHaveBeenCalled();
    },
  );

  it("rejects caller price, URL, customer, account and unsupported locale before SDK dispatch", async () => {
    for (const extra of [
      { priceId: "price_caller" },
      { returnUrl: "https://foreign.example.test" },
      { customerId: "cus_caller" },
      { accountId: "acct_caller" },
      { locale: "de" },
    ]) {
      await request(app.getHttpServer())
        .post("/api/billing/checkout")
        .set("Origin", origin)
        .send({ planId: "operator_plan", locale: "en", ...extra })
        .expect(400);
    }
    await request(app.getHttpServer())
      .post("/api/billing/portal")
      .set("Origin", origin)
      .send({ locale: "en", customerId: "cus_caller" })
      .expect(400);
    expect(billing.start).not.toHaveBeenCalled();
    expect(billing.portal).not.toHaveBeenCalled();
  });

  it("keeps public plans and signed raw webhook dispatch exempt from the cookie origin guard", async () => {
    await request(app.getHttpServer()).get("/api/billing/plans").expect(200);
    const raw = '{"spaces":  true}\n';
    await request(app.getHttpServer())
      .post("/api/billing/webhook")
      .set("Origin", "https://foreign.example.test")
      .set("Content-Type", "application/json")
      .set("stripe-signature", "t=contract,v1=contract")
      .send(raw)
      .expect(200);
    expect(billing.webhook).toHaveBeenCalledExactlyOnceWith(
      Buffer.from(raw),
      "t=contract,v1=contract",
    );
    billing.webhook.mockClear();
    await request(app.getHttpServer())
      .post("/api/billing/webhook")
      .set("Content-Type", "application/json")
      .send(raw)
      .expect(400);
    expect(billing.webhook).not.toHaveBeenCalled();
  });
});
