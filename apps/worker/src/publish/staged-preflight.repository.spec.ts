import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
type DatabaseModule = typeof import("@pubrick/db");
type PublishRepository = InstanceType<typeof import("./publish.repository").PublishRepository>;
type StagedRepository = InstanceType<
  typeof import("./staged-publication.repository").StagedPublicationRepository
>;
type StagedPreflightFence = import("./staged-publication.contract").StagedPreflightFence;
type Boss = import("pg-boss").PgBoss;

/** No native platform check is weakened: the terminal fence is independent of its adapter. */
describe.skipIf(!url)("late Meta preflight terminal recording on PostgreSQL", () => {
  let pool: ReturnType<DatabaseModule["createDb"]>["pool"];
  let repo: PublishRepository;
  let staged: StagedRepository;
  let boss: Boss;
  const queue = `meta-preflight-${randomUUID()}`;
  const organizations: string[] = [];

  beforeAll(async () => {
    const parsed = url && new URL(url);
    if (
      !parsed ||
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ||
      !/^\/pubrick_.*_test$/.test(parsed.pathname)
    )
      throw new Error("A disposable pubrick_*_test database is required");
    if (!url) throw new Error("A disposable database URL is required");
    process.env.DATABASE_URL = url;
    const database = await import("@pubrick/db");
    await database.runMigrations(url);
    ({ pool } = await import("../db"));
    const { PgBoss } = await import("pg-boss");
    boss = new PgBoss({ connectionString: url, schedule: false, supervise: false });
    await boss.start();
    await boss.createQueue(queue, { expireInSeconds: 180, retryLimit: 0 });
    repo = new (await import("./publish.repository")).PublishRepository();
    staged = new (await import("./staged-publication.repository")).StagedPublicationRepository();
  }, 60_000);

  afterAll(async () => {
    if (pool) {
      await pool.query("DELETE FROM pgboss.job WHERE name=$1", [queue]);
      for (const orgId of organizations)
        await pool.query("DELETE FROM organization WHERE id=$1", [orgId]);
    }
    await boss?.stop();
    await pool?.end();
  });

  async function fixture() {
    const orgId = `meta-preflight-${randomUUID()}`;
    const brandId = randomUUID();
    const channelId = randomUUID();
    const contentId = randomUUID();
    const adaptationId = randomUUID();
    organizations.push(orgId);
    await pool.query("INSERT INTO organization(id,name,slug) VALUES($1,'Fixture',$1)", [orgId]);
    await pool.query("INSERT INTO brands(id,org_id,name) VALUES($1,$2,'Fixture')", [
      brandId,
      orgId,
    ]);
    await pool.query(
      "INSERT INTO channels(id,org_id,brand_id,platform,name,credentials_encrypted,connection_target) VALUES($1,$2,$3,'wordpress','Fixture','opaque-fixture-bag','wordpress:https://fixture.example.com/')",
      [channelId, orgId, brandId],
    );
    await pool.query(
      "INSERT INTO content_items(id,org_id,brand_id,body,status) VALUES($1,$2,$3,'Reviewed text','approved')",
      [contentId, orgId, brandId],
    );
    await pool.query(
      "INSERT INTO adaptations(id,org_id,content_item_id,channel_id,status) VALUES($1,$2,$3,$4,'queued')",
      [adaptationId, orgId, contentId, channelId],
    );
    const jobId = await boss.send(queue, { orgId, adaptationId });
    const [job] = await boss.fetch<{ orgId: string; adaptationId: string }>(queue, {
      includeMetadata: true,
    });
    if (!jobId || job?.id !== jobId) throw new Error("Fixture job was not fetched");
    const delivery = await staged.load(orgId, adaptationId);
    if (!delivery) throw new Error("Fixture delivery could not be read");
    const preflight: StagedPreflightFence = {
      delivery,
      execution: { jobId, queue, startedOn: job.startedOn, retryCount: job.retryCount },
    };
    return { orgId, brandId, channelId, contentId, adaptationId, jobId, preflight };
  }

  function fail(f: Awaited<ReturnType<typeof fixture>>, orgId = f.orgId) {
    return repo.markFailed(
      orgId,
      f.adaptationId,
      "Meta access check did not finish; no preparation or publication was requested",
      "rejected_before_send",
      { status: "queued", attemptCount: 0 },
      "failed",
      undefined,
      undefined,
      f.preflight,
    );
  }
  async function saved(f: Awaited<ReturnType<typeof fixture>>) {
    return {
      adaptation: (await pool.query("SELECT * FROM adaptations WHERE id=$1", [f.adaptationId]))
        .rows,
      publications: (
        await pool.query("SELECT * FROM publications WHERE adaptation_id=$1 ORDER BY id", [
          f.adaptationId,
        ])
      ).rows,
      item: (await pool.query("SELECT * FROM content_items WHERE id=$1", [f.contentId])).rows,
    };
  }

  it("records a visible known-not-sent outcome only for the same current active decision", async () => {
    const f = await fixture();
    expect(await fail(f)).toBe(true);
    const result = await saved(f);
    expect(result.adaptation[0]).toMatchObject({ status: "failed", attempt_count: 1 });
    expect(result.publications).toHaveLength(1);
    expect(result.publications[0]).toMatchObject({ status: "failed", external_id: null });
    expect(await fail(f)).toBe(false);
    expect(await saved(f)).toEqual(result);
  });

  it.each([
    "input",
    "decision",
    "attempt",
    "cancelled",
    "archived",
    "credentials",
    "generation",
    "target",
    "slot",
  ])("preserves the newer %s after a read-only network wait", async (kind) => {
    const f = await fixture();
    if (kind === "input")
      await pool.query("UPDATE content_items SET body='New reviewed text' WHERE id=$1", [
        f.contentId,
      ]);
    if (kind === "decision")
      await pool.query(
        "UPDATE adaptations SET updated_at=updated_at+interval '1 microsecond' WHERE id=$1",
        [f.adaptationId],
      );
    if (kind === "attempt")
      await pool.query("UPDATE adaptations SET attempt_count=1 WHERE id=$1", [f.adaptationId]);
    if (kind === "cancelled")
      await pool.query("UPDATE adaptations SET status='pending' WHERE id=$1", [f.adaptationId]);
    if (kind === "archived")
      await pool.query(
        "UPDATE content_items SET archived_from_status=status,status='archived' WHERE id=$1",
        [f.contentId],
      );
    if (kind === "credentials")
      await pool.query(
        "UPDATE channels SET credentials_encrypted='replacement-opaque-bag' WHERE id=$1",
        [f.channelId],
      );
    if (kind === "generation")
      await pool.query(
        "UPDATE channels SET connection_generation=connection_generation+1 WHERE id=$1",
        [f.channelId],
      );
    if (kind === "target")
      await pool.query(
        "UPDATE channels SET connection_target='wordpress:https://other.example.com/' WHERE id=$1",
        [f.channelId],
      );
    if (kind === "slot")
      await pool.query("UPDATE adaptations SET scheduled_at=now()+interval '1 hour' WHERE id=$1", [
        f.adaptationId,
      ]);
    const before = await saved(f);
    expect(await fail(f)).toBe(false);
    expect(await saved(f)).toEqual(before);
  });

  it.each(["cancelled", "retry", "start", "expired", "queue", "payload"])(
    "refuses the no-longer-current %s queue incarnation",
    async (kind) => {
      const f = await fixture();
      if (kind === "cancelled")
        await pool.query("UPDATE pgboss.job SET state='cancelled' WHERE id=$1 AND name=$2", [
          f.jobId,
          queue,
        ]);
      if (kind === "retry")
        await pool.query(
          "UPDATE pgboss.job SET retry_count=retry_count+1 WHERE id=$1 AND name=$2",
          [f.jobId, queue],
        );
      if (kind === "start")
        await pool.query(
          "UPDATE pgboss.job SET started_on=started_on+interval '1 second' WHERE id=$1 AND name=$2",
          [f.jobId, queue],
        );
      if (kind === "expired") {
        const result = await pool.query(
          "UPDATE pgboss.job SET started_on=clock_timestamp()-interval '10 seconds',expire_seconds=1 WHERE id=$1 AND name=$2 RETURNING started_on",
          [f.jobId, queue],
        );
        f.preflight.execution.startedOn = result.rows[0].started_on;
      }
      if (kind === "queue") f.preflight.execution.queue = "other-fixture-queue";
      if (kind === "payload")
        await pool.query(
          "UPDATE pgboss.job SET data=jsonb_set(data,'{orgId}','\"another-org\"') WHERE id=$1 AND name=$2",
          [f.jobId, queue],
        );
      const before = await saved(f);
      expect(await fail(f)).toBe(false);
      expect(await saved(f)).toEqual(before);
    },
  );
  it("does not overwrite a durable unknown receipt from another claim", async () => {
    const f = await fixture();
    await pool.query(
      "INSERT INTO publications(org_id,adaptation_id,channel_id,status,attempt,external_id) VALUES($1,$2,$3,'unknown',0,'retained-remote-post')",
      [f.orgId, f.adaptationId, f.channelId],
    );
    const before = await saved(f);
    expect(await fail(f)).toBe(false);
    expect(await saved(f)).toEqual(before);
  });
  it("rechecks database wall time after waiting for the job lock", async () => {
    const f = await fixture();
    const before = await saved(f);
    await pool.query("UPDATE pgboss.job SET expire_seconds=3 WHERE id=$1 AND name=$2", [
      f.jobId,
      queue,
    ]);
    const holder = await pool.connect();
    let completion: Promise<boolean> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM pgboss.job WHERE id=$1 AND name=$2 FOR UPDATE", [
        f.jobId,
        queue,
      ]);
      completion = fail(f);
      await vi.waitFor(
        async () => {
          const result = await pool.query(
            "SELECT count(*)::int AS count FROM pg_stat_activity WHERE wait_event_type='Lock' AND query ILIKE '%pgboss.job j%' AND query ILIKE '%for share%'",
          );
          expect(result.rows[0].count).toBeGreaterThan(0);
        },
        { timeout: 1500, interval: 25 },
      );
      await holder.query(
        "SELECT pg_sleep(greatest(0,extract(epoch FROM started_on+interval '3 seconds'-clock_timestamp()))+0.05) FROM pgboss.job WHERE id=$1 AND name=$2",
        [f.jobId, queue],
      );
      await holder.query("ROLLBACK");
      expect(await completion).toBe(false);
      expect(await saved(f)).toEqual(before);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
      await completion;
    }
  }, 10_000);
  it("cannot apply one tenant's saved preflight to another tenant", async () => {
    const f = await fixture();
    const other = await fixture();
    const before = await saved(f);
    const otherBefore = await saved(other);
    expect(await fail(f, other.orgId)).toBe(false);
    expect(await saved(f)).toEqual(before);
    expect(await saved(other)).toEqual(otherBefore);
    expect(await fail(other)).toBe(true);
  });
});
