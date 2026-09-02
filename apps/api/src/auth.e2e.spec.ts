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
