import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { schema } from "@pubrick/db";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
// From auth-policy, not from the gate: the gate imports ./db, whose env parsing runs
// at import time and would fire before beforeAll sets DATABASE_URL.
import { SIGNUP_DISABLED_CODE, SIGNUP_DISABLED_MESSAGE } from "./auth-policy";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("auth e2e", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    // Migrations run once for the whole suite in vitest.global-setup.ts (a single
    // barrier, instead of six e2e files each racing runMigrations() against the
    // same DB — that redundant per-file migration dance is what caused the
    // "beforeAll hook timed out" flake).
    const { AppModule } = await import("./app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
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

  it("signs up and reads the session back via cookie", async () => {
    const agent = request.agent(app.getHttpServer());
    const email = `u${Date.now()}@example.com`;
    const signUp = await agent
      .post("/api/auth/sign-up/email")
      .send({ email, password: "password1234", name: "Test User" });
    expect(signUp.status).toBe(200);

    const session = await agent.get("/api/auth/get-session");
    expect(session.status).toBe(200);
    expect(session.body.user.email).toBe(email);
  });

  it("health stays anonymous", async () => {
    await request(app.getHttpServer()).get("/api/health").expect(200);
  });

  // A returning member's fresh session must already carry their organization: without
  // it the web app reads activeOrganizationId === null and sends someone who already
  // has a workspace to /onboarding to create a second one.
  it("a returning member's new sign-in session carries their organization", async () => {
    const email = `u${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`;
    const password = "password1234";

    const first = request.agent(app.getHttpServer());
    await first.post("/api/auth/sign-up/email").send({ email, password, name: "Returning" });
    const created = await first
      .post("/api/auth/organization/create")
      .send({ name: "Returning Co", slug: `returning-${Date.now()}` })
      .expect(200);
    const orgId = created.body.id as string;

    // A brand new cookie jar: this is the LATER sign-in, not the sign-up session.
    const second = request.agent(app.getHttpServer());
    await second.post("/api/auth/sign-in/email").send({ email, password }).expect(200);

    const session = await second.get("/api/auth/get-session").expect(200);
    expect(session.body.session.activeOrganizationId).toBe(orgId);
  });

  it("a member of several organizations gets the earliest one they joined", async () => {
    const email = `u${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`;
    const password = "password1234";

    const first = request.agent(app.getHttpServer());
    await first.post("/api/auth/sign-up/email").send({ email, password, name: "Multi" });
    const earliest = await first
      .post("/api/auth/organization/create")
      .send({ name: "First Co", slug: `first-${Date.now()}` })
      .expect(200);
    await first
      .post("/api/auth/organization/create")
      .send({ name: "Second Co", slug: `second-${Date.now()}` })
      .expect(200);

    const second = request.agent(app.getHttpServer());
    await second.post("/api/auth/sign-in/email").send({ email, password }).expect(200);

    const session = await second.get("/api/auth/get-session").expect(200);
    expect(session.body.session.activeOrganizationId).toBe(earliest.body.id);
  });

  it("a user with no organization still gets a session with no active org", async () => {
    const email = `u${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`;
    const password = "password1234";

    const first = request.agent(app.getHttpServer());
    await first
      .post("/api/auth/sign-up/email")
      .send({ email, password, name: "Orgless" })
      .expect(200);

    const second = request.agent(app.getHttpServer());
    await second.post("/api/auth/sign-in/email").send({ email, password }).expect(200);

    const session = await second.get("/api/auth/get-session").expect(200);
    expect(session.body.session.activeOrganizationId ?? null).toBeNull();
  });

  /**
   * Registration posture. Pubrick's own docs tell operators to put this on a public URL,
   * and until now that URL accepted anyone's sign-up, unverified, with permission to
   * create organizations — so a stranger could make N of them and the per-org concurrency
   * cap capped nothing.
   *
   * The gate reads SIGNUP_MODE per request (see auth-signup-gate.ts), which is what lets
   * these drive all three postures against the one app booted for this file. The suite's
   * own default is pinned to `open` in vitest.config.ts, restored after each test here.
   */
  describe("registration posture", () => {
    const OPEN = process.env.SIGNUP_MODE;
    afterEach(() => {
      if (OPEN === undefined) {
        // Deleted, not assigned undefined: assignment stores the STRING "undefined".
        delete process.env.SIGNUP_MODE;
      } else {
        process.env.SIGNUP_MODE = OPEN;
      }
    });

    const fresh = () => `u${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`;

    const signUp = (email: string) =>
      request(app.getHttpServer())
        .post("/api/auth/sign-up/email")
        .send({ email, password: "password1234", name: "Posture" });

    it("open lets anyone register", async () => {
      process.env.SIGNUP_MODE = "open";
      await signUp(fresh()).expect(200);
    });

    it("closed refuses with one generic answer", async () => {
      process.env.SIGNUP_MODE = "closed";
      const response = await signUp(fresh()).expect(403);
      expect(response.body).toMatchObject({
        code: SIGNUP_DISABLED_CODE,
        message: SIGNUP_DISABLED_MESSAGE,
      });
    });

    // The enumeration property, stated as an equality rather than as two separate
    // assertions: better-auth's sign-up answers USER_ALREADY_EXISTS for a registered
    // address and 200 for a fresh one, so with the gate off this test fails by design.
    it("closed answers a registered address exactly as it answers an unknown one", async () => {
      const registered = fresh();
      process.env.SIGNUP_MODE = "open";
      await signUp(registered).expect(200);

      process.env.SIGNUP_MODE = "closed";
      const known = await signUp(registered);
      const unknown = await signUp(fresh());

      expect(known.status).toBe(unknown.status);
      expect(known.body).toEqual(unknown.body);
      expect(known.status).toBe(403);
    });

    it("invite refuses an address nobody invited, with the same generic answer", async () => {
      process.env.SIGNUP_MODE = "invite";
      const response = await signUp(fresh()).expect(403);
      expect(response.body).toMatchObject({ code: SIGNUP_DISABLED_CODE });
    });

    // The organization plugin's invitation is the way in: a pending invitation for that
    // exact address is what lets the sign-up through.
    it("invite lets an invited address register", async () => {
      process.env.SIGNUP_MODE = "open";
      const owner = request.agent(app.getHttpServer());
      await owner
        .post("/api/auth/sign-up/email")
        .send({ email: fresh(), password: "password1234", name: "Owner" })
        .expect(200);
      const org = await owner
        .post("/api/auth/organization/create")
        .send({ name: "Invite Co", slug: `invite-${Date.now()}` })
        .expect(200);

      const invited = fresh();
      // organizationId explicitly: `organization/create` does not make the new org the
      // session's active one — the web onboarding flow calls set-active itself.
      await owner
        .post("/api/auth/organization/invite-member")
        .send({ email: invited, role: "member", organizationId: org.body.id })
        .expect(200);

      process.env.SIGNUP_MODE = "invite";
      await signUp(invited).expect(200);
      // and still nobody else
      await signUp(fresh()).expect(403);
    });

    // Address comparison is lowered on both sides: the plugin stores the invitation
    // lowercased, so an invitee who types their address in caps must not be turned away.
    it("invite matches the invited address case-insensitively", async () => {
      process.env.SIGNUP_MODE = "open";
      const owner = request.agent(app.getHttpServer());
      await owner
        .post("/api/auth/sign-up/email")
        .send({ email: fresh(), password: "password1234", name: "Owner" })
        .expect(200);
      const org = await owner
        .post("/api/auth/organization/create")
        .send({ name: "Case Co", slug: `case-${Date.now()}` })
        .expect(200);

      const invited = fresh();
      await owner
        .post("/api/auth/organization/invite-member")
        .send({ email: invited, role: "member", organizationId: org.body.id })
        .expect(200);

      process.env.SIGNUP_MODE = "invite";
      await signUp(invited.toUpperCase()).expect(200);
    });

    /**
     * A real, live invitation for a fresh address, created through the plugin's own
     * endpoints so the row under test is byte-for-byte the row production writes —
     * `status` and `expiresAt` included, neither of them invented here.
     */
    async function inviteFreshAddress(label: string) {
      process.env.SIGNUP_MODE = "open";
      const owner = request.agent(app.getHttpServer());
      await owner
        .post("/api/auth/sign-up/email")
        .send({ email: fresh(), password: "password1234", name: "Owner" })
        .expect(200);
      const org = await owner
        .post("/api/auth/organization/create")
        .send({
          name: `${label} Co`,
          slug: `${label}-${Date.now()}${Math.floor(Math.random() * 1e6)}`,
        })
        .expect(200);
      const email = fresh();
      const invited = await owner
        .post("/api/auth/organization/invite-member")
        .send({ email, role: "member", organizationId: org.body.id })
        .expect(200);
      const invitationId = invited.body.id as string;
      expect(typeof invitationId).toBe("string");
      return { owner, email, invitationId };
    }

    /**
     * The invitation row as stored. Imported dynamically for the reason at the top of
     * this file: `./db` parses env at import time, which must not happen before
     * `beforeAll` has set DATABASE_URL.
     */
    async function invitationRow(invitationId: string) {
      const { db } = await import("./db");
      const [row] = await db
        .select()
        .from(schema.invitation)
        .where(eq(schema.invitation.id, invitationId))
        .limit(1);
      if (!row) throw new Error(`invitation ${invitationId} not found`);
      return row;
    }

    /**
     * MUTATION PIN for `hasPendingInvitation`'s expiry half. An invitation is two
     * separate facts — a status and an expiry — and only the pair makes it live.
     * Every earlier invite test used an invitation that was fresh in both, so
     * deleting `gt(expiresAt, now)` left the suite green while an invitation sent
     * to an address a year ago went on admitting whoever now controls it.
     *
     * The expiry is moved by writing the row: the plugin sets `expiresAt` itself and
     * exposes no way to age it. That single write is the only fabricated step — the
     * invitation, its status and the sign-up are all the real endpoints.
     */
    it("invite refuses an expired invitation, with the answer a stranger gets", async () => {
      const { email, invitationId } = await inviteFreshAddress("expired");
      const { db } = await import("./db");
      await db
        .update(schema.invitation)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(schema.invitation.id, invitationId));
      // Still `pending`: this is the expiry check acting alone, with the status
      // check unable to cover for it.
      expect((await invitationRow(invitationId)).status).toBe("pending");

      process.env.SIGNUP_MODE = "invite";
      const refused = await signUp(email);
      const stranger = await signUp(fresh());

      expect(refused.status).toBe(403);
      // Byte-identical to the never-invited refusal. Anything more specific — "your
      // invitation expired" — confirms to whoever is asking that this address was
      // once invited, which is the enumeration oracle the generic answer exists to
      // deny.
      expect(refused.status).toBe(stranger.status);
      expect(refused.body).toEqual(stranger.body);
    });

    /**
     * MUTATION PIN for the status half, driven entirely through the plugin: revoking
     * an invitation is the one way an operator takes an invite back, and the address
     * must stop being able to register the moment they do. The expiry is untouched
     * and still in the future, so only `eq(status, "pending")` can refuse this.
     */
    it("invite refuses a revoked invitation, with the answer a stranger gets", async () => {
      const { owner, email, invitationId } = await inviteFreshAddress("revoked");
      await owner
        .post("/api/auth/organization/cancel-invitation")
        .send({ invitationId })
        .expect(200);

      const row = await invitationRow(invitationId);
      // Read back rather than assumed. The gate keys on the ONE live value,
      // `pending`, precisely so that it does not have to know how the library
      // spells the others; this asserts the revoke moved the row off `pending`
      // without hardcoding which word it moved to.
      expect(row.status).not.toBe("pending");
      expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());

      process.env.SIGNUP_MODE = "invite";
      const refused = await signUp(email);
      const stranger = await signUp(fresh());

      expect(refused.status).toBe(403);
      expect(refused.body).toEqual(stranger.body);
    });

    /**
     * The third dead state, and the one an attacker can reach without any operator
     * action: an invitation that has already been used. A single-use invite that
     * stays usable is a shared password with an expiry date.
     */
    it("invite refuses an already-accepted invitation", async () => {
      const { email, invitationId } = await inviteFreshAddress("accepted");
      const { db } = await import("./db");
      // Written directly because accepting requires being signed in as the invitee,
      // and the invitee having no account yet is the whole premise of this gate.
      await db
        .update(schema.invitation)
        .set({ status: "accepted" })
        .where(eq(schema.invitation.id, invitationId));
      expect((await invitationRow(invitationId)).expiresAt.getTime()).toBeGreaterThan(Date.now());

      process.env.SIGNUP_MODE = "invite";
      const refused = await signUp(email);
      const stranger = await signUp(fresh());

      expect(refused.status).toBe(403);
      expect(refused.body).toEqual(stranger.body);
    });

    /**
     * THE JOURNEY, end to end, with nothing fabricated: a member creates an
     * invitation, the stranger it names registers on it and ends up inside the
     * organization, and a stranger without one is still refused.
     *
     * The inviter is deliberately NOT the founder. The organization plugin gives
     * `invitation: ["create"]` to `owner` and `admin` only, so on its stock
     * configuration this test's second half is a 403 and a self-hosted instance
     * is single-inviter forever: the one account that ran `docker compose up`
     * can add people, and nobody it adds can add anybody. `auth.ts` grants the
     * verb to `member`; this is the test that says so.
     */
    it("a member — not the founder — invites a stranger, who registers on it and lands inside the organization", async () => {
      process.env.SIGNUP_MODE = "open";
      const founder = request.agent(app.getHttpServer());
      await founder
        .post("/api/auth/sign-up/email")
        .send({ email: fresh(), password: "password1234", name: "Founder" })
        .expect(200);
      const org = await founder
        .post("/api/auth/organization/create")
        .send({
          name: "Journey Co",
          slug: `journey-${Date.now()}${Math.floor(Math.random() * 1e6)}`,
        })
        .expect(200);
      const orgId = org.body.id as string;

      // A plain member: invited by the founder, registered on that invitation,
      // and holding whatever role the invitation carried — `member`.
      const memberEmail = fresh();
      await founder
        .post("/api/auth/organization/invite-member")
        .send({ email: memberEmail, role: "member", organizationId: orgId })
        .expect(200);

      process.env.SIGNUP_MODE = "invite";
      const member = request.agent(app.getHttpServer());
      await member
        .post("/api/auth/sign-up/email")
        .send({ email: memberEmail, password: "password1234", name: "Member" })
        .expect(200);

      // They discover the invitation through the product's own read, which is the
      // one the onboarding screen makes: the plugin's list-user-invitations
      // refuses every unverified address, and this install verifies none.
      const offered = await member.get("/api/org/invitations").expect(200);
      expect(offered.body).toHaveLength(1);
      expect(offered.body[0].organizationId).toBe(orgId);
      expect(offered.body[0].organizationName).toBe("Journey Co");

      await member
        .post("/api/auth/organization/accept-invitation")
        .send({ invitationId: offered.body[0].id })
        .expect(200);

      // Inside, read from the membership rather than from the cookie that just
      // wrote itself: a FRESH sign-in mints a session whose active organization
      // comes from `findInitialOrganizationId`, i.e. from a `member` row.
      const returning = request.agent(app.getHttpServer());
      await returning
        .post("/api/auth/sign-in/email")
        .send({ email: memberEmail, password: "password1234" })
        .expect(200);
      const memberSession = await returning.get("/api/auth/get-session").expect(200);
      expect(memberSession.body.session.activeOrganizationId).toBe(orgId);
      // ...and nothing is waiting for them any more.
      expect((await returning.get("/api/org/invitations").expect(200)).body).toEqual([]);

      // Now the half the plugin's defaults refuse: a `member` invites. No
      // organizationId in the body — the session carries it, which is the call
      // the Settings screen makes.
      const strangerEmail = fresh();
      const created = await returning
        .post("/api/auth/organization/invite-member")
        .send({ email: strangerEmail, role: "member" })
        .expect(200);
      expect(created.body.organizationId).toBe(orgId);

      // The stranger they named gets in...
      const stranger = request.agent(app.getHttpServer());
      await stranger
        .post("/api/auth/sign-up/email")
        .send({ email: strangerEmail, password: "password1234", name: "Stranger" })
        .expect(200);
      const strangerOffer = await stranger.get("/api/org/invitations").expect(200);
      expect(strangerOffer.body).toHaveLength(1);
      await stranger
        .post("/api/auth/organization/accept-invitation")
        .send({ invitationId: strangerOffer.body[0].id })
        .expect(200);

      const strangerReturning = request.agent(app.getHttpServer());
      await strangerReturning
        .post("/api/auth/sign-in/email")
        .send({ email: strangerEmail, password: "password1234" })
        .expect(200);
      expect(
        (await strangerReturning.get("/api/auth/get-session").expect(200)).body.session
          .activeOrganizationId,
      ).toBe(orgId);

      // ...and a stranger nobody named still does not. This is the assertion the
      // whole gate exists for, and it runs at the END of the journey on purpose:
      // everything above widened the instance by two accounts, and none of it may
      // have widened it by a third.
      await signUp(fresh()).expect(403);
    });

    /**
     * Single use, proved through the endpoints rather than by writing `accepted`
     * into the row (which "invite refuses an already-accepted invitation" above
     * does, and which cannot see a plugin that stops writing that status).
     *
     * Two replays, because they are different attacks: presenting the same
     * invitation id a second time, and registering the invited address a second
     * time. The first is the person who reloads the Join screen; the second is
     * whoever else has the link.
     */
    it("an accepted invitation cannot be replayed, by its id or by its address", async () => {
      process.env.SIGNUP_MODE = "open";
      const owner = request.agent(app.getHttpServer());
      await owner
        .post("/api/auth/sign-up/email")
        .send({ email: fresh(), password: "password1234", name: "Owner" })
        .expect(200);
      const org = await owner
        .post("/api/auth/organization/create")
        .send({ name: "Replay Co", slug: `replay-${Date.now()}${Math.floor(Math.random() * 1e6)}` })
        .expect(200);
      const invitedEmail = fresh();
      const invitation = await owner
        .post("/api/auth/organization/invite-member")
        .send({ email: invitedEmail, role: "member", organizationId: org.body.id })
        .expect(200);
      const invitationId = invitation.body.id as string;

      process.env.SIGNUP_MODE = "invite";
      const invitee = request.agent(app.getHttpServer());
      await invitee
        .post("/api/auth/sign-up/email")
        .send({ email: invitedEmail, password: "password1234", name: "Invitee" })
        .expect(200);
      await invitee
        .post("/api/auth/organization/accept-invitation")
        .send({ invitationId })
        .expect(200);

      // Replay one: the same id again, by the same person who legitimately used it.
      const replayed = await invitee
        .post("/api/auth/organization/accept-invitation")
        .send({ invitationId });
      expect(replayed.status).toBeGreaterThanOrEqual(400);

      // Replay two: whoever else holds the link tries the address. The gate
      // refuses BEFORE better-auth's sign-up can answer USER_ALREADY_EXISTS, so
      // the answer is byte-identical to a stranger's — a spent invitation must
      // not become an oracle for "this address has an account here".
      const reused = await signUp(invitedEmail);
      const strangerAnswer = await signUp(fresh());
      expect(reused.status).toBe(403);
      expect(reused.body).toEqual(strangerAnswer.body);
    });

    // The unset default. By the time this runs the instance certainly has accounts —
    // this file created several — so `auto` must have closed itself.
    it("unset means invite-only once the instance has an account", async () => {
      // Deleted, not assigned undefined: the gate must see the variable genuinely
      // UNSET, and assignment would leave the string "undefined" in process.env.
      delete process.env.SIGNUP_MODE;
      await signUp(fresh()).expect(403);
    });

    // A typo must not silently leave registration more open than the operator asked for.
    it("refuses to serve sign-up at all on an unrecognised SIGNUP_MODE", async () => {
      process.env.SIGNUP_MODE = "invite-only";
      const response = await signUp(fresh());
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).not.toBe(200);
    });
  });
});
