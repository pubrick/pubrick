import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, schema } from "@pubrick/db";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("brand access e2e", () => {
  let app: INestApplication;
  let db: ReturnType<typeof createDb>["db"];
  let pool: ReturnType<typeof createDb>["pool"];

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    ({ db, pool } = createDb(url as string));
    const { AppModule } = await import("../app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    await app.listen(0);
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  async function signUp(name: string) {
    const agent = request.agent(app.getHttpServer());
    const suffix = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const signed = await agent
      .post("/api/auth/sign-up/email")
      .send({ email: `${name.toLowerCase()}${suffix}@example.com`, password: "password1234", name })
      .expect(200);
    return { agent, userId: signed.body.user.id as string };
  }

  async function createOrg(owner: Awaited<ReturnType<typeof signUp>>) {
    const suffix = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const created = await owner.agent
      .post("/api/auth/organization/create")
      .send({ name: `Org ${suffix}`, slug: `grant-org-${suffix}` })
      .expect(200);
    await owner.agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: created.body.id })
      .expect(200);
    return created.body.id as string;
  }

  async function addMember(orgId: string, person: Awaited<ReturnType<typeof signUp>>) {
    const memberId = randomUUID();
    await db.insert(schema.member).values({
      id: memberId,
      organizationId: orgId,
      userId: person.userId,
      role: "member",
    });
    await person.agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);
    return memberId;
  }

  it("lets managers replace grants, keeps their bypass, and confines changes to the organization", async () => {
    const owner = await signUp("Owner");
    const orgId = await createOrg(owner);
    const brandId = (await owner.agent.post("/api/brands").send({ name: "One" }).expect(201)).body
      .id as string;
    const secondBrandId = (await owner.agent.post("/api/brands").send({ name: "Two" }).expect(201))
      .body.id as string;
    const member = await signUp("Member");
    const memberId = await addMember(orgId, member);
    const otherOwner = await signUp("Other");
    const otherOrgId = await createOrg(otherOwner);
    const otherMember = await signUp("Outsider");
    const otherMemberId = await addMember(otherOrgId, otherMember);

    const { BrandAccessRepository } = await import("./brand-access.repository");
    const access = app.get(BrandAccessRepository);
    expect(await access.visibleBrandIds(orgId, owner.userId)).toBeNull();
    expect(await access.visibleBrandIds(orgId, member.userId)).toEqual([]);
    expect(await access.hasAccess(orgId, brandId, member.userId)).toBe(false);
    expect(await access.hasAccess(orgId, brandId, owner.userId)).toBe(true);

    const firstList = await owner.agent.get(`/api/brands/${brandId}/access`).expect(200);
    expect(firstList.body.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ memberId, role: "member", hasAccess: false }),
        expect.objectContaining({ userId: owner.userId, role: "owner", hasAccess: true }),
      ]),
    );
    expect(
      firstList.body.members.some((row: { memberId: string }) => row.memberId === otherMemberId),
    ).toBe(false);
    const ownerMemberId = firstList.body.members.find(
      (row: { userId: string }) => row.userId === owner.userId,
    )?.memberId as string | undefined;
    if (!ownerMemberId) throw new Error("Owner membership missing from access list");
    await owner.agent
      .put(`/api/brands/${brandId}/access`)
      .send({ memberIds: [ownerMemberId] })
      .expect(400);

    await member.agent.get(`/api/brands/${brandId}/access`).expect(403);
    await member.agent.put(`/api/brands/${brandId}/access`).send({ memberIds: [] }).expect(403);
    await otherOwner.agent.get(`/api/brands/${brandId}/access`).expect(404);
    await otherOwner.agent
      .put(`/api/brands/${brandId}/access`)
      .send({ memberIds: [otherMemberId] })
      .expect(404);

    const granted = await owner.agent
      .put(`/api/brands/${brandId}/access`)
      .send({ memberIds: [memberId] })
      .expect(200);
    expect(granted.body.members).toEqual(
      expect.arrayContaining([expect.objectContaining({ memberId, hasAccess: true })]),
    );
    expect(await access.visibleBrandIds(orgId, member.userId)).toEqual([brandId]);
    expect(await access.hasAccess(orgId, secondBrandId, member.userId)).toBe(false);

    await owner.agent
      .put(`/api/brands/${brandId}/access`)
      .send({ memberIds: [memberId, memberId] })
      .expect(400);
    await owner.agent
      .put(`/api/brands/${brandId}/access`)
      .send({ memberIds: [otherMemberId] })
      .expect(400);
    expect(await access.visibleBrandIds(orgId, member.userId)).toEqual([brandId]);

    const revoked = await owner.agent
      .put(`/api/brands/${brandId}/access`)
      .send({ memberIds: [] })
      .expect(200);
    expect(revoked.body.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ memberId, hasAccess: false }),
        expect.objectContaining({ userId: owner.userId, hasAccess: true }),
      ]),
    );
    expect(await access.hasAccess(orgId, brandId, member.userId)).toBe(false);
    expect(await access.hasAccess(otherOrgId, brandId, otherOwner.userId)).toBe(false);

    await db.update(schema.member).set({ role: "admin" }).where(eq(schema.member.id, memberId));
    expect(await access.visibleBrandIds(orgId, member.userId)).toBeNull();
    expect(await access.hasAccess(orgId, secondBrandId, member.userId)).toBe(true);
    await db.update(schema.member).set({ role: "member" }).where(eq(schema.member.id, memberId));
    expect(await access.visibleBrandIds(orgId, member.userId)).toEqual([]);
  });
});
