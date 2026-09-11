import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { decodeContentCursor, encodeContentCursor } from "@pubrick/shared";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const APP_NAME = "content-paging-e2e";
const appUrl = url ? `${url}${url.includes("?") ? "&" : "?"}application_name=${APP_NAME}` : url;

/**
 * `GET /api/content?limit=&cursor=` — that the pages of one queue are the queue,
 * exactly once each, and that a cursor is the one query parameter a caller
 * cannot use to reach another organisation's rows.
 *
 * Kept apart from `content.e2e.spec.ts` (six thousand lines about one draft's
 * lifecycle) and from `content-list-cost.e2e.spec.ts` (what one page costs)
 * because what it is about is neither: it is about the SET the pages add up to.
 * Every assertion is scoped to ids this file created, per `docs/mutation-
 * testing.md` — the suites share one database and never truncate it, so a count
 * of anything, or "some row exists", would eventually be answered by another
 * run's leftovers.
 */
describe.skipIf(!url)("paging the queue", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL = appUrl as string;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    const { AppModule } = await import("../app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  async function orgAgent(): Promise<{
    agent: request.Agent;
    orgId: string;
    brandId: string;
    channelId: string;
  }> {
    const agent = request.agent(app.getHttpServer());
    const uniq = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email: `u${uniq}@example.com`, password: "password1234", name: "U" })
      .expect(200);
    const created = await agent
      .post("/api/auth/organization/create")
      .send({ name: `Org ${uniq}`, slug: `org-${uniq}` })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: created.body.id })
      .expect(200);
    const brand = await agent.post("/api/brands").send({ name: "B" }).expect(201);
    // `contentCreateSchema` requires at least one channel, so a draft through
    // the real route needs one; nothing here reads the channel strip.
    const channel = await agent
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "telegram",
        name: "Main",
        credentials: { botToken: "123:abc", chatId: "-1001234567890" },
      })
      .expect(201);
    return {
      agent,
      orgId: created.body.id as string,
      brandId: brand.body.id as string,
      channelId: channel.body.id as string,
    };
  }

  /** One draft through the real route, so its columns are the ones a writer fills. */
  async function draft(
    org: { agent: request.Agent; brandId: string; channelId: string },
    title: string,
  ): Promise<string> {
    const created = await org.agent
      .post("/api/content")
      .send({ brandId: org.brandId, title, body: "Deux mots.", channelIds: [org.channelId] })
      .expect(201);
    return created.body.id as string;
  }

  type Page = { ids: string[]; cursor: string | undefined };

  async function page(agent: request.Agent, query: string): Promise<Page> {
    const response = await agent.get(`/api/content${query}`).expect(200);
    return {
      ids: (response.body as { id: string }[]).map((row) => row.id),
      cursor: response.headers["x-next-cursor"] as string | undefined,
    };
  }

  /** Every page of one query, walked to exhaustion, with a bound on the walk. */
  async function walk(agent: request.Agent, base: string, limit: number): Promise<string[][]> {
    const pages: string[][] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard += 1) {
      const suffix = cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`;
      const next = await page(agent, `${base}limit=${limit}${suffix}`);
      pages.push(next.ids);
      if (next.cursor === undefined) return pages;
      cursor = next.cursor;
    }
    throw new Error("the walk never reached a page without a cursor");
  }

  /**
   * THE PAGES ARE THE QUEUE, EXACTLY ONCE EACH — over rows that SHARE a
   * `created_at` to the microsecond, which is the only fixture that can see
   * the defect.
   *
   * Every draft here is written by ONE `INSERT`, where `now()` is a single
   * value, so all nine rows carry the same instant and the whole order is
   * decided by the `id` tiebreak. That is not a contrived shape: it is what the
   * generate worker produces every time it writes an item and its adaptations
   * in one transaction. On such rows the boundary between page 1 and page 2
   * falls INSIDE a tie, so a `<=` where the predicate should read `<` re-serves
   * the last card of each page as the first card of the next, and a key without
   * the `id` half loses whole pages. With distinct timestamps neither mutation
   * is visible: the pages still partition the set.
   *
   * Asserted as a partition rather than as three literal pages: what matters is
   * that the union is the whole queue and the intersection is empty.
   */
  it("partitions a queue whose rows share one instant, with no gap and no repeat", async () => {
    const { agent, orgId, brandId } = await orgAgent();
    const { createDb, schema } = await import("@pubrick/db");
    const seed = createDb(url as string);
    let all: string[];
    try {
      const rows = await seed.db
        .insert(schema.contentItems)
        .values(
          Array.from({ length: 9 }, (_unused, index) => ({
            orgId,
            brandId,
            title: `Tied ${index}`,
            body: "Deux mots.",
          })),
        )
        .returning({ id: schema.contentItems.id });
      all = rows.map((row) => row.id);
    } finally {
      await seed.pool.end();
    }

    // The same nine rows in one read, which is the order the walk must
    // reproduce — taken from the api rather than assumed, so this is a
    // statement about paging and not about `id` sort order.
    const whole = await page(agent, "?limit=9");
    expect(whole.ids.toSorted()).toEqual(all.toSorted());
    expect(whole.cursor).toBeUndefined();

    const pages = await walk(agent, "?", 4);
    expect(pages.map((p) => p.length)).toEqual([4, 4, 1]);
    // Concatenated: the same rows, in the same order, each exactly once. A
    // `toSorted` comparison would pass with two pages swapped.
    expect(pages.flat()).toEqual(whole.ids);
  });

  /**
   * ...AND THE SAME OVER DISTINCT INSTANTS, so the walk is not an accident of
   * nine rows sharing one.
   *
   * Nine separate `POST`s, nine distinct `created_at`s (microseconds apart, and
   * the cursor carries all six digits — a millisecond-precision cursor would
   * re-serve the boundary row here, which is why `CURSOR_AT` renders the key in
   * SQL rather than reading the driver's `Date`).
   */
  it("partitions a queue of distinct instants the same way", async () => {
    const org = await orgAgent();
    const { agent } = org;
    const created: string[] = [];
    for (let index = 0; index < 9; index += 1) {
      created.push(await draft(org, `Draft ${index}`));
    }

    const whole = await page(agent, "?limit=9");
    expect(whole.ids).toEqual(created.toReversed());

    const pages = await walk(agent, "?", 2);
    expect(pages.flat()).toEqual(created.toReversed());
  });

  /**
   * The header is the only thing that says whether there is more, so its
   * absence has to mean what a reader will take it to mean. A cursor emitted on
   * the last page is a `Load more` control that never goes away and a read that
   * always answers `[]`; a cursor withheld one page early loses the tail of the
   * queue silently.
   *
   * Both halves in one test, over the exact boundary: a page holding the last
   * row must not carry one, and the page before it must.
   */
  it("sets the cursor when a page is followed by another, and not when it is the last", async () => {
    const org = await orgAgent();
    const { agent } = org;
    for (let index = 0; index < 4; index += 1) await draft(org, `Draft ${index}`);

    const first = await page(agent, "?limit=2");
    expect(first.cursor).toBeDefined();
    const second = await page(
      agent,
      `?limit=2&cursor=${encodeURIComponent(first.cursor as string)}`,
    );
    expect(second.ids).toHaveLength(2);
    // Four rows, two per page: the second page IS the last one, even though it
    // is full. "Full" and "followed by another" are different questions, and a
    // cursor emitted whenever the page is full answers the wrong one.
    expect(second.cursor).toBeUndefined();

    // ...and asked for exactly the queue's length in one page, likewise.
    const exact = await page(agent, "?limit=4");
    expect(exact.ids).toHaveLength(4);
    expect(exact.cursor).toBeUndefined();
  });

  /**
   * THE FILTER IS SERVER-SIDE AND SURVIVES THE CURSOR.
   *
   * The queue's status chips set `?status=`, and they exist so a chip does not
   * fetch every draft an organisation owns to show four of them. A `cursor`
   * branch that dropped the status predicate would page through the WHOLE queue
   * while the screen believed it was paging through one status — visible to a
   * reader only as cards of the wrong status appearing under a filtered
   * heading, on page two and never page one.
   */
  it("keeps the status filter on every page, not only the first", async () => {
    const org = await orgAgent();
    const { agent } = org;
    const drafts: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      const id = await draft(org, `Draft ${index}`);
      // Every other one is rejected, so the filtered queue is interleaved with
      // rows the filter must skip rather than sitting in one block.
      if (index % 2 === 0) await agent.post(`/api/content/${id}/reject`).expect(200);
      else drafts.push(id);
    }

    const pages = await walk(agent, "?status=draft&", 2);
    expect(pages.flat()).toEqual(drafts.toReversed());
    expect(pages.map((p) => p.length)).toEqual([2, 1]);
  });

  /**
   * A CURSOR IS A POSITION, NEVER AN AUTHORISATION.
   *
   * It carries no organisation — see `decodeContentCursor` — so another
   * tenant's cursor is a perfectly well-formed one, and the only thing standing
   * between it and their rows is the `org_id` predicate in the repository. A
   * refusal would be the wrong answer as well as an unreachable one: the cursor
   * names an instant, and instants are not owned.
   *
   * So the assertion is the sharp one, in both directions at once. The stranger
   * gets ITS OWN rows from after that position — not an empty list, which a
   * broken query would also produce and which would make this test pass for the
   * wrong reason — and never the row the cursor was cut from. The fixture is
   * interleaved in time on purpose: one stranger draft before the owner's
   * cursor position and one after, so a cursor that was IGNORED (returning both)
   * fails just as loudly as one that leaked.
   */
  it("answers another org's cursor with this org's page after that position, never theirs", async () => {
    const stranger = await orgAgent();
    const owner = await orgAgent();

    const strangerOlder = await draft(stranger, "Stranger, older");
    const ownerOlder = await draft(owner, "Owner, older");
    const ownerNewer = await draft(owner, "Owner, newer");
    const strangerNewer = await draft(stranger, "Stranger, newer");

    // The owner's own page 1 of 1, whose cursor names the position just after
    // `ownerNewer` — which is between the stranger's two drafts in time.
    const ownersPage = await page(owner.agent, "?limit=1");
    expect(ownersPage.ids).toEqual([ownerNewer]);
    const ownersCursor = ownersPage.cursor as string;
    expect(ownersCursor).toBeDefined();

    const stolen = await page(
      stranger.agent,
      `?limit=10&cursor=${encodeURIComponent(ownersCursor)}`,
    );
    expect(stolen.ids).toEqual([strangerOlder]);
    expect(stolen.ids).not.toContain(ownerOlder);
    expect(stolen.ids).not.toContain(ownerNewer);
    // ...and the stranger's own newer draft is correctly EXCLUDED, which is
    // what says the cursor was applied rather than ignored.
    expect(stolen.ids).not.toContain(strangerNewer);
  });

  /**
   * A CURSOR THIS API DID NOT WRITE IS A 400 WITH A CODE, NOT A 500.
   *
   * Both halves matter. Reaching drizzle, these values become
   * `invalid input syntax for type timestamp with time zone` — a 500, for a
   * request the CALLER got wrong, which is an alert to the operator and a
   * sentence the screen cannot translate. And the code is what `errorMessage`
   * turns into a sentence in the reader's language; a refusal with no code
   * leaves them the api's English.
   *
   * The list covers each way the decoder can say no: not base64url at all, a
   * base64url payload that is not a cursor, and — the one worth writing out —
   * a payload whose halves are individually plausible but whose timestamp is
   * not the canonical six-digit form. That last is what a client that tried to
   * BUILD a cursor would produce.
   */
  it.each([
    ["not base64url", "not a cursor!"],
    ["base64url of something else", Buffer.from("hello").toString("base64url")],
    ["a cursor with no id", Buffer.from("2026-09-11T19:09:52.123456Z").toString("base64url")],
    [
      "a timestamp a client made up",
      Buffer.from("2026-09-11T19:09:52Z|33333333-3333-4333-8333-333333333333").toString(
        "base64url",
      ),
    ],
    [
      "an id that is not a uuid",
      Buffer.from("2026-09-11T19:09:52.123456Z|nope").toString("base64url"),
    ],
  ])("400s %s instead of 500ing on the cast", async (_label, cursor) => {
    const { agent } = await orgAgent();
    const refused = await agent
      .get(`/api/content?cursor=${encodeURIComponent(cursor)}`)
      .expect(400);
    expect(refused.body.code).toBe("invalid_request");
  });

  /**
   * THE CEILING IS REFUSED, NOT CLAMPED.
   *
   * Serving 200 rows to a caller that asked for 5 000 lets it go on believing
   * it holds the whole queue — which is the belief the bound exists to take
   * away, and the one every caller of this endpoint held until it landed. A
   * refusal is the only answer that tells them.
   *
   * `0` and a non-number are here for the mirror reason: answering them with
   * the default would be inventing an intent nobody expressed.
   */
  it.each([
    ["above the ceiling", "201"],
    ["far above the ceiling", "1000000"],
    ["zero", "0"],
    ["negative", "-1"],
    ["fractional", "1.5"],
    ["not a number", "all"],
    ["empty", ""],
  ])("400s a limit that is %s", async (_label, limit) => {
    const { agent } = await orgAgent();
    const refused = await agent.get(`/api/content?limit=${limit}`).expect(400);
    expect(refused.body.code).toBe("invalid_request");
  });

  /**
   * The default is 50 — the owner's answer to design 0009 §6.1 — and it is
   * asserted through the route rather than against the constant, because what
   * ships is what the route does with it.
   */
  it("defaults to a page of 50", async () => {
    const { agent, orgId, brandId } = await orgAgent();
    const { createDb, schema } = await import("@pubrick/db");
    const seed = createDb(url as string);
    try {
      await seed.db.insert(schema.contentItems).values(
        Array.from({ length: 51 }, (_unused, index) => ({
          orgId,
          brandId,
          title: `Draft ${index}`,
          body: "Deux mots.",
        })),
      );
    } finally {
      await seed.pool.end();
    }

    const first = await page(agent, "?");
    expect(first.ids).toHaveLength(50);
    expect(first.cursor).toBeDefined();
    // The cursor names the LAST ROW OF THE PAGE, not the one that was cut off:
    // the next page starts after what the reader has, so naming the extra row
    // would skip it.
    expect(decodeContentCursor(first.cursor as string)?.id).toBe(first.ids[49]);

    const second = await page(agent, `?cursor=${encodeURIComponent(first.cursor as string)}`);
    expect(second.ids).toHaveLength(1);
    expect(second.cursor).toBeUndefined();
  });

  /**
   * A cursor is opaque BY CONTRACT — and this is the half of that contract a
   * test can hold: nothing this api returns hands one out in readable form. The
   * key it encodes is stripped from every row alongside `body`, so a caller
   * cannot reconstruct the next page's cursor from the last card it drew, which
   * is what would pin the ordering from outside.
   */
  it("does not put the cursor's own sort key on a card", async () => {
    const org = await orgAgent();
    const { agent } = org;
    const id = await draft(org, "Only");
    const response = await agent.get("/api/content").expect(200);
    const [row] = response.body as Record<string, unknown>[];
    expect(row).toBeDefined();
    if (row === undefined) throw new Error("the queue answered with no rows");
    expect(row.id).toBe(id);
    expect(row).not.toHaveProperty("cursorAt");
    expect(row).not.toHaveProperty("body");
    // The cursor for this very row, as the api would encode it, must not be
    // findable in what the api sent.
    const forgeable = encodeContentCursor({
      createdAt: `${(row.createdAt as string).replace("Z", "")}000Z`,
      id,
    });
    expect(response.text).not.toContain(forgeable);
  });
});
