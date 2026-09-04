import { Controller, Get, type INestApplication, UseGuards } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, schema } from "@pubrick/db";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("org scoping e2e", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    // Migrations run once for the whole suite in vitest.global-setup.ts (a single
    // barrier, instead of six e2e files each racing runMigrations() against the
    // same DB — that redundant per-file migration dance is what caused the
    // "beforeAll hook timed out" flake).

    const { AppModule } = await import("../app.module");
    const { ActiveOrgGuard } = await import("./active-org.guard");
    const { OrgId } = await import("./org-id.decorator");

    @Controller("org-probe")
    @UseGuards(ActiveOrgGuard)
    class OrgProbeController {
      @Get()
      probe(@OrgId() orgId: string): { orgId: string } {
        return { orgId };
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [OrgProbeController],
    }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    // Listen for the whole file: supertest otherwise starts the server per
    // request and closes it when that request ends, killing any other request
    // in flight (see content.e2e.spec.ts for the measurement).
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  async function signUpAgent() {
    const agent = request.agent(app.getHttpServer());
    const email = `u${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`;
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email, password: "password1234", name: "U" })
      .expect(200);
    return agent;
  }

  /** A fresh organization the agent's user is a member of. Returns its id. */
  async function createOrg(agent: request.Agent, label: string): Promise<string> {
    const created = await agent
      .post("/api/auth/organization/create")
      .send({
        name: `Acme ${label}`,
        slug: `acme-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      })
      .expect(200);
    return created.body.id as string;
  }

  it("403s when no active organization is set, and NAMES the refusal in the body", async () => {
    const agent = await signUpAgent();
    const refused = await agent.get("/api/org-probe").expect(403);

    // The code, not the sentence. The web branches on this to send the account
    // to onboarding, and it used to decide that by matching
    // /no active organization/i against the prose below — so a reword here, or
    // a translation of it, would silently strand an account on a screen it can
    // never load. The sentence stays, for the network tab and for an API
    // consumer; what a browser acts on is the code beside it.
    expect(refused.body.code).toBe("no_active_organization");
    expect(refused.body.statusCode).toBe(403);
    expect(refused.body.message).toBe("No active organization; create or select one first");
  });

  it("403s a caller who is not a member WITHOUT that code", async () => {
    // The guard's other refusal, and it must not look like the one above: this
    // account HAS an organization, it simply is not in this one, so sending it
    // to onboarding would be a loop. One code shared by both is the single
    // mistake this pair exists to prevent.
    const agent = request.agent(app.getHttpServer());
    const email = `u${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`;
    const signUp = await agent
      .post("/api/auth/sign-up/email")
      .send({ email, password: "password1234", name: "U" })
      .expect(200);
    const cookie = sessionTokenCookie(signUp.headers["set-cookie"]);
    const userId = signUp.body.user.id as string;

    const stranger = await signUpAgent();
    const theirs = await createOrg(stranger, "notmine");
    await setSessionActiveOrg(userId, theirs);

    const refused = await request(app.getHttpServer())
      .get("/api/org-probe")
      .set("Cookie", cookie)
      .expect(403);

    expect(refused.body.code).toBeUndefined();
  });

  it("passes org id through after create + set-active", async () => {
    const agent = await signUpAgent();
    const slug = `acme-${Date.now()}`;
    const created = await agent
      .post("/api/auth/organization/create")
      .send({ name: "Acme", slug })
      .expect(200);
    const orgId = created.body.id as string;
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);
    const probe = await agent.get("/api/org-probe").expect(200);
    expect(probe.body.orgId).toBe(orgId);
  });

  it("401s without a session", async () => {
    await request(app.getHttpServer()).get("/api/org-probe").expect(401);
  });

  /**
   * The session-token cookie on its own, WITHOUT better-auth's `session_data`
   * cache cookie.
   *
   * That cache holds a signed copy of the session row — `activeOrganizationId`
   * included — and is served for five minutes without touching the database, so
   * a test that plants a session row and then uses the agent's full cookie jar
   * silently asserts nothing at all. Sending the token alone forces the read.
   */
  function sessionTokenCookie(setCookie: string | string[] | undefined): string {
    const cookies = typeof setCookie === "string" ? [setCookie] : (setCookie ?? []);
    const token = cookies.find((cookie) => cookie.startsWith("better-auth.session_token="));
    if (!token) throw new Error("sign-up returned no session token cookie");
    return token.split(";")[0] as string;
  }

  async function setSessionActiveOrg(userId: string, orgId: string): Promise<void> {
    const { db, pool } = createDb(url as string);
    await db
      .update(schema.session)
      .set({ activeOrganizationId: orgId })
      .where(eq(schema.session.userId, userId));
    await pool.end();
  }

  it("403s a session pointing at an organization the caller never joined", async () => {
    const agent = request.agent(app.getHttpServer());
    const email = `u${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`;
    const signUp = await agent
      .post("/api/auth/sign-up/email")
      .send({ email, password: "password1234", name: "U" })
      .expect(200);
    const cookie = sessionTokenCookie(signUp.headers["set-cookie"]);
    const userId = signUp.body.user.id as string;

    const mine = await createOrg(agent, "mine");
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: mine })
      .expect(200);

    const stranger = await signUpAgent();
    const theirs = await createOrg(stranger, "theirs");

    // Planted, because no endpoint will write it: better-auth's own set-active
    // checks membership before it stores an id, so this is the shape a FUTURE
    // writer of that column gets wrong — and the guard is what stands behind it.
    await setSessionActiveOrg(userId, theirs);
    await request(app.getHttpServer()).get("/api/org-probe").set("Cookie", cookie).expect(403);

    // The control, and it is not optional: the same bare cookie on the same
    // route must still be ACCEPTED once the session points somewhere legitimate.
    // Without it, a 403 from a request that simply failed to authenticate would
    // read as proof of scoping.
    await setSessionActiveOrg(userId, mine);
    const probe = await request(app.getHttpServer())
      .get("/api/org-probe")
      .set("Cookie", cookie)
      .expect(200);
    expect(probe.body.orgId).toBe(mine);
  });

  it("403s an active org the caller was removed from, while their membership ELSEWHERE survives", async () => {
    const agent = await signUpAgent();
    const kept = await createOrg(agent, "kept");
    const revoked = await createOrg(agent, "revoked");
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: revoked })
      .expect(200);
    await agent.get("/api/org-probe").expect(200);

    const session = await agent.get("/api/auth/get-session").expect(200);
    const userId = session.body.user.id as string;
    const { db, pool } = createDb(url as string);
    await db
      .delete(schema.member)
      .where(and(eq(schema.member.organizationId, revoked), eq(schema.member.userId, userId)));
    await pool.end();

    // The membership read asks TWO questions of one row, and only the pair is
    // an answer. The test above this one leaves the user with no membership
    // anywhere, so `user_id` alone still finds nothing and the org half of the
    // predicate is never consulted. Here the user is still a member of `kept`,
    // so dropping `organization_id` from that read hands the guard a row it
    // should never have seen — and the request proceeds with an org id the
    // caller was removed from, which is the whole of what the guard prevents.
    await agent.get("/api/org-probe").expect(403);

    // ...and the organization they ARE in still passes, so the 403 above is
    // this pair rather than a guard that has started refusing everything.
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: kept })
      .expect(200);
    expect((await agent.get("/api/org-probe").expect(200)).body.orgId).toBe(kept);
  });

  it("403s again once membership is revoked, even though activeOrganizationId is still set", async () => {
    const agent = await signUpAgent();
    const slug = `acme-${Date.now()}-revoke`;
    const created = await agent
      .post("/api/auth/organization/create")
      .send({ name: "Acme Revoke", slug })
      .expect(200);
    const orgId = created.body.id as string;
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);
    await agent.get("/api/org-probe").expect(200);

    const { db, pool } = createDb(url as string);
    await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
    await pool.end();

    await agent.get("/api/org-probe").expect(403);
  });

  /**
   * `GET /api/org/invitations` — the read the onboarding screen makes for a
   * brand-new account, and the only way an invited person can find out which
   * organization is expecting them.
   *
   * It exists because the plugin's own `/organization/list-user-invitations`
   * refuses every account whose address is unverified, and Pubrick verifies no
   * addresses — there is no mailer to verify them with. On a stock install that
   * endpoint answers 403 to everybody, which is why this one is not a wrapper.
   */
  describe("pending invitations for the signed-in account", () => {
    /** An organization with a live invitation for `email`, created through the plugin. */
    async function inviteTo(email: string, orgName: string) {
      const owner = await signUpAgent();
      const created = await owner
        .post("/api/auth/organization/create")
        .send({
          name: orgName,
          slug: `inv-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        })
        .expect(200);
      const invitation = await owner
        .post("/api/auth/organization/invite-member")
        .send({ email, role: "member", organizationId: created.body.id })
        .expect(200);
      const ownerSession = await owner.get("/api/auth/get-session").expect(200);
      return {
        owner,
        orgId: created.body.id as string,
        invitationId: invitation.body.id as string,
        inviterEmail: ownerSession.body.user.email as string,
      };
    }

    /** A signed-up agent for one specific address (`signUpAgent` picks its own). */
    async function signUpAs(email: string) {
      const agent = request.agent(app.getHttpServer());
      await agent
        .post("/api/auth/sign-up/email")
        .send({ email, password: "password1234", name: "Invitee" })
        .expect(200);
      return agent;
    }

    it("401s without a session", async () => {
      await request(app.getHttpServer()).get("/api/org/invitations").expect(401);
    });

    it("names the organization and the person who invited them", async () => {
      const email = `u${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`;
      const { orgId, invitationId, inviterEmail } = await inviteTo(email, "Named Co");
      const invitee = await signUpAs(email);

      const offered = await invitee.get("/api/org/invitations").expect(200);
      expect(offered.body).toEqual([
        {
          id: invitationId,
          organizationId: orgId,
          organizationName: "Named Co",
          inviterEmail,
          expiresAt: expect.any(String),
        },
      ]);
    });

    it("offers only the invitations addressed to the caller", async () => {
      const mine = `u${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`;
      const theirs = `u${Date.now()}${Math.floor(Math.random() * 1e6)}b@example.com`;
      const { invitationId } = await inviteTo(mine, "Mine Co");
      await inviteTo(theirs, "Theirs Co");

      const invitee = await signUpAs(mine);
      const offered = await invitee.get("/api/org/invitations").expect(200);
      expect(offered.body.map((row: { id: string }) => row.id)).toEqual([invitationId]);
    });

    // The plugin lowercases the address it stores; a person who typed theirs in
    // caps must still be shown their own invitation, or the signup gate lets
    // them register and this screen then tells them nobody invited them.
    it("matches the address case-insensitively, as the signup gate does", async () => {
      const email = `U${Date.now()}${Math.floor(Math.random() * 1e6)}@Example.com`;
      const { invitationId } = await inviteTo(email, "Caps Co");
      const invitee = await signUpAs(email);

      const offered = await invitee.get("/api/org/invitations").expect(200);
      expect(offered.body.map((row: { id: string }) => row.id)).toEqual([invitationId]);
    });

    /**
     * MUTATION PIN for the status half. Revoking is how an invitation is taken
     * back; the expiry is untouched and still in the future, so only the
     * `status = 'pending'` clause can drop this row.
     */
    it("does not offer a revoked invitation", async () => {
      const email = `u${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`;
      const { owner, invitationId } = await inviteTo(email, "Revoked Co");
      const invitee = await signUpAs(email);
      expect((await invitee.get("/api/org/invitations").expect(200)).body).toHaveLength(1);

      // Through the plugin, which is how an operator actually takes one back.
      await owner
        .post("/api/auth/organization/cancel-invitation")
        .send({ invitationId })
        .expect(200);
      const { db, pool } = createDb(url as string);
      const [row] = await db
        .select()
        .from(schema.invitation)
        .where(eq(schema.invitation.id, invitationId))
        .limit(1);
      await pool.end();
      // Read back rather than assumed: the expiry is untouched, so the status
      // clause is the only thing that can drop this row.
      expect(row?.status).not.toBe("pending");
      expect(row?.expiresAt.getTime()).toBeGreaterThan(Date.now());

      expect((await invitee.get("/api/org/invitations").expect(200)).body).toEqual([]);
    });

    /**
     * MUTATION PIN for the expiry half. The row stays `pending` — the plugin
     * never sweeps it — so only `expires_at > now()` can drop it. Offering it
     * would put a Join button in front of somebody that `accept-invitation` is
     * certain to refuse.
     */
    it("does not offer an expired invitation, though it is still pending", async () => {
      const email = `u${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`;
      const { invitationId } = await inviteTo(email, "Stale Co");
      const invitee = await signUpAs(email);
      expect((await invitee.get("/api/org/invitations").expect(200)).body).toHaveLength(1);

      const { db, pool } = createDb(url as string);
      await db
        .update(schema.invitation)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(schema.invitation.id, invitationId));
      const [row] = await db
        .select()
        .from(schema.invitation)
        .where(eq(schema.invitation.id, invitationId))
        .limit(1);
      await pool.end();
      expect(row?.status).toBe("pending");

      expect((await invitee.get("/api/org/invitations").expect(200)).body).toEqual([]);
    });
  });
});
