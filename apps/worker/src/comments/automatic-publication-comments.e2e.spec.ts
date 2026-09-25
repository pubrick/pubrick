import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("automatic Telegram publication reply samples", () => {
  let repo: import("./comments.repository").CommentsRepository;
  let service: import("./comments.service").CommentsService;
  let db: ReturnType<typeof import("@pubrick/db").createDb>["db"];
  let pool: ReturnType<typeof import("@pubrick/db").createDb>["pool"];
  let schema: typeof import("@pubrick/db").schema;
  let eq: typeof import("drizzle-orm").eq;
  const telegram = { comments: vi.fn() };
  const orgs: string[] = [];
  const sample = {
    status: "available" as const,
    comments: [{ messageId: 7, body: "A useful public reply", publishedAt: new Date() }],
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    const module = await import("@pubrick/db");
    schema = module.schema;
    ({ db, pool } = module.createDb(url as string));
    ({ eq } = await import("drizzle-orm"));
    repo = new (await import("./comments.repository")).CommentsRepository();
    service = new (await import("./comments.service")).CommentsService(repo, telegram as never);
  });
  afterEach(async () => {
    vi.resetAllMocks();
    for (const orgId of orgs.splice(0))
      await db.delete(schema.organization).where(eq(schema.organization.id, orgId));
  });
  afterAll(async () => {
    if (pool) await pool.end();
  });

  async function fixture(enabled = true) {
    const orgId = randomUUID();
    orgs.push(orgId);
    await db
      .insert(schema.organization)
      .values({ id: orgId, name: "Publication replies", slug: `publication-replies-${orgId}` });
    const [brand] = await db
      .insert(schema.brands)
      .values({ orgId, name: "Brand" })
      .returning({ id: schema.brands.id });
    if (!brand) throw new Error("Missing brand");
    const brandId = brand.id;
    const [channel] = await db
      .insert(schema.channels)
      .values({
        orgId,
        brandId,
        name: "Public Telegram",
        platform: "telegram",
        credentialsEncrypted: "test-only",
      })
      .returning({ id: schema.channels.id });
    if (!channel) throw new Error("Missing channel");
    await db.insert(schema.telegramSourceAccounts).values({ orgId, sessionEncrypted: "test-only" });
    await db
      .insert(schema.publicationCommentCollectionConfigs)
      .values({ orgId, brandId, enabled, revision: 1 });
    return { orgId, brandId, channelId: channel.id };
  }

  async function publication(
    f: Awaited<ReturnType<typeof fixture>>,
    n: number,
    options: {
      ageHours?: number;
      externalUrl?: string;
      status?: "published" | "failed";
    } = {},
  ) {
    const [item] = await db
      .insert(schema.contentItems)
      .values({
        orgId: f.orgId,
        brandId: f.brandId,
        body: `Post ${n}`,
        status: "published",
      })
      .returning({ id: schema.contentItems.id });
    if (!item) throw new Error("Missing item");
    const [adaptation] = await db
      .insert(schema.adaptations)
      .values({
        orgId: f.orgId,
        contentItemId: item.id,
        channelId: f.channelId,
        status: "published",
      })
      .returning({ id: schema.adaptations.id });
    if (!adaptation) throw new Error("Missing adaptation");
    const [receipt] = await db
      .insert(schema.publications)
      .values({
        orgId: f.orgId,
        adaptationId: adaptation.id,
        channelId: f.channelId,
        status: options.status ?? "published",
        externalId: String(n),
        externalUrl: options.externalUrl ?? `https://t.me/public_channel/${n}`,
        createdAt: new Date(Date.now() - (options.ageHours ?? 7) * 3600_000),
      })
      .returning({ id: schema.publications.id });
    if (!receipt) throw new Error("Missing receipt");
    return receipt.id;
  }

  function job(f: Awaited<ReturnType<typeof fixture>>, publicationId: string, revision = 1) {
    return {
      kind: "publication_auto" as const,
      orgId: f.orgId,
      brandId: f.brandId,
      publicationId,
      revision,
    };
  }

  it("defaults to opt-out and selects only exact-age live public posts, with a global brand cap", async () => {
    const off = await fixture(false);
    const offId = await publication(off, 1);
    const first = await fixture();
    const eligible = await publication(first, 2);
    await pool.query(
      "UPDATE publications SET created_at = now() - interval '6 hours' WHERE id = $1",
      [eligible],
    );
    await publication(first, 3, { ageHours: 5 });
    await publication(first, 4, { externalUrl: "https://t.me/c/123/4" });
    await publication(first, 5, { status: "failed" });
    const checked = await publication(first, 6);
    await db.insert(schema.publicationCommentSamples).values({
      orgId: first.orgId,
      brandId: first.brandId,
      publicationId: checked,
      status: "no_comments",
    });
    const others = await Promise.all(
      Array.from({ length: 10 }, async (_, i) => {
        const f = await fixture();
        await publication(f, i + 10);
        return f;
      }),
    );
    for (const other of others)
      await pool.query(
        "UPDATE publication_comment_collection_configs SET last_scanned_at = now() - interval '2 hours' WHERE brand_id = $1",
        [other.brandId],
      );
    const send = vi.fn().mockResolvedValue(randomUUID());
    expect(await repo.scanPublicationsAuto({ send } as never)).toBe(10);
    expect(send).toHaveBeenCalledTimes(10);
    expect(send.mock.calls.map((call) => call[1].publicationId)).toContain(eligible);
    expect(send.mock.calls.map((call) => call[1].publicationId)).not.toContain(checked);
    expect(send.mock.calls.map((call) => call[1].orgId)).not.toContain(off.orgId);
    const firstJob = send.mock.calls.find((call) => call[1].publicationId === eligible)?.[1];
    expect(firstJob).toEqual(job(first, eligible));
    expect(await repo.eligiblePublicationAuto(job(first, eligible))).not.toBeNull();
    expect(await repo.eligiblePublicationAuto(job(off, offId))).toBeNull();
    expect(others).toHaveLength(10);
  });

  it("leaves a lost job eligible, but records a completed result once despite redelivery", async () => {
    const f = await fixture();
    const id = await publication(f, 42);
    const send = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(randomUUID());
    expect(await repo.scanPublicationsAuto({ send } as never)).toBe(0);
    expect(
      await db
        .select({ id: schema.publicationCommentSamples.publicationId })
        .from(schema.publicationCommentSamples)
        .where(eq(schema.publicationCommentSamples.orgId, f.orgId)),
    ).toEqual([]);
    await pool.query(
      "UPDATE publication_comment_collection_configs SET last_scanned_at = now() - interval '2 hours' WHERE brand_id = $1",
      [f.brandId],
    );
    expect(await repo.scanPublicationsAuto({ send } as never)).toBe(1);
    await repo.savePublicationAuto(job(f, id), `https://t.me/public_channel/42`, sample);
    await repo.savePublicationAuto(job(f, id), `https://t.me/public_channel/42`, sample);
    expect(
      await db
        .select({ id: schema.publicationComments.id })
        .from(schema.publicationComments)
        .where(eq(schema.publicationComments.orgId, f.orgId)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(schema.paidReplyAnalysisHandoffs)
        .where(eq(schema.paidReplyAnalysisHandoffs.targetId, id)),
    ).toHaveLength(0);
    expect(await repo.eligiblePublicationAuto(job(f, id))).toBeNull();
  });

  it("commits one opted-in paid handoff with the free publication sample", async () => {
    const f = await fixture();
    const id = await publication(f, 45);
    await db
      .update(schema.brandPaidReplySettings)
      .set({ publicationEnabled: true, publicationRevision: 1 })
      .where(eq(schema.brandPaidReplySettings.brandId, f.brandId));
    await repo.savePublicationAuto(job(f, id), "https://t.me/public_channel/45", sample);
    await repo.savePublicationAuto(job(f, id), "https://t.me/public_channel/45", sample);
    const [saved] = await db
      .select({ version: schema.publicationCommentSamples.sampleVersion })
      .from(schema.publicationCommentSamples)
      .where(eq(schema.publicationCommentSamples.publicationId, id));
    const handoffs = await db
      .select()
      .from(schema.paidReplyAnalysisHandoffs)
      .where(eq(schema.paidReplyAnalysisHandoffs.targetId, id));
    expect(saved?.version).toBeTruthy();
    expect(handoffs).toMatchObject([
      {
        orgId: f.orgId,
        brandId: f.brandId,
        targetKind: "publication_comment",
        targetId: id,
        sampleVersion: saved?.version,
        freeRevision: 1,
        paidRevision: 1,
        status: "pending",
      },
    ]);
  });

  it("caps a busy brand at 50 publications and rejects a foreign or detached receipt", async () => {
    const f = await fixture();
    const ids: string[] = [];
    for (let n = 1; n <= 51; n++) ids.push(await publication(f, n));
    const firstId = ids.at(0);
    if (!firstId) throw new Error("Missing first publication");
    const send = vi.fn().mockResolvedValue(randomUUID());
    expect(await repo.scanPublicationsAuto({ send } as never)).toBe(50);
    expect(send).toHaveBeenCalledTimes(50);
    expect(
      await repo.eligiblePublicationAuto({ ...job(f, firstId), orgId: randomUUID() }),
    ).toBeNull();
    expect(
      await repo.eligiblePublicationAuto({ ...job(f, firstId), brandId: randomUUID() }),
    ).toBeNull();
    await db.delete(schema.channels).where(eq(schema.channels.id, f.channelId));
    expect(await repo.eligiblePublicationAuto(job(f, firstId))).toBeNull();
    await repo.savePublicationAuto(job(f, firstId), "https://t.me/public_channel/1", sample);
    expect(
      await db
        .select({ id: schema.publicationCommentSamples.publicationId })
        .from(schema.publicationCommentSamples)
        .where(eq(schema.publicationCommentSamples.orgId, f.orgId)),
    ).toEqual([]);
  });

  it("fences opt-out and off/on cycles after Telegram I/O, without AI", async () => {
    const f = await fixture();
    const id = await publication(f, 43);
    let resolve!: (value: typeof sample) => void;
    telegram.comments.mockReturnValue(
      new Promise<typeof sample>((done) => {
        resolve = done;
      }),
    );
    const work = service.handle(job(f, id));
    await vi.waitFor(() => expect(telegram.comments).toHaveBeenCalledOnce());
    await db
      .update(schema.publicationCommentCollectionConfigs)
      .set({ enabled: false, revision: 2 })
      .where(eq(schema.publicationCommentCollectionConfigs.brandId, f.brandId));
    resolve(sample);
    await work;
    expect(
      await db
        .select({ id: schema.publicationCommentSamples.publicationId })
        .from(schema.publicationCommentSamples)
        .where(eq(schema.publicationCommentSamples.orgId, f.orgId)),
    ).toEqual([]);
    await db
      .update(schema.publicationCommentCollectionConfigs)
      .set({ enabled: true, revision: 3 })
      .where(eq(schema.publicationCommentCollectionConfigs.brandId, f.brandId));
    expect(await repo.eligiblePublicationAuto(job(f, id))).toBeNull();
    expect(await repo.eligiblePublicationAuto(job(f, id, 3))).not.toBeNull();
    expect(telegram.comments).toHaveBeenCalledOnce();
  });

  it("does not overwrite a manual sample admitted while Telegram was being read", async () => {
    const f = await fixture();
    const id = await publication(f, 44);
    let resolve!: (value: typeof sample) => void;
    telegram.comments.mockReturnValue(
      new Promise<typeof sample>((done) => {
        resolve = done;
      }),
    );
    const work = service.handle(job(f, id));
    await vi.waitFor(() => expect(telegram.comments).toHaveBeenCalledOnce());
    await db
      .insert(schema.publicationCommentSamples)
      .values({ orgId: f.orgId, brandId: f.brandId, publicationId: id, status: "pending" });
    resolve(sample);
    await work;
    const [saved] = await db
      .select({ status: schema.publicationCommentSamples.status })
      .from(schema.publicationCommentSamples)
      .where(eq(schema.publicationCommentSamples.publicationId, id));
    expect(saved?.status).toBe("pending");
    expect(
      await db
        .select({ id: schema.publicationComments.id })
        .from(schema.publicationComments)
        .where(eq(schema.publicationComments.orgId, f.orgId)),
    ).toEqual([]);
  });
});
