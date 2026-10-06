import { randomUUID } from "node:crypto";
import {
  AcceptedPublicationError,
  PermanentPublishError,
  type StagedPublisher,
  threadsCredentialsSchema,
  UnknownOutcomePublishError,
  UnknownPreparationError,
} from "@pubrick/integrations";
import { encryptJson, META_PUBLICATION_QUEUE_OPTIONS } from "@pubrick/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
type Database = typeof import("@pubrick/db");
type StageRepository = InstanceType<
  typeof import("./staged-publication.repository").StagedPublicationRepository
>;
type Service = InstanceType<typeof import("./publish.service").PublishService>;
type Execution = import("./staged-publication.contract").StagedExecution;
type Boss = import("pg-boss").PgBoss;
const policy = { delayMs: 30_000, maxPolls: 120, deadlineMs: 3_600_000 };
const actualReceipt = { externalId: "55667", externalUrl: null };

/** Actual scoped DB and pg-boss paths; only the provider HTTP boundary is replaced. */
describe.skipIf(!url)("native Meta same-attempt worker acceptance on PostgreSQL", () => {
  let pool: ReturnType<Database["createDb"]>["pool"];
  let stages: StageRepository;
  let service: Service;
  let boss: Boss;
  const queue = `meta-stage-${randomUUID()}`;
  const ready = `${queue}-meta-publication`;
  const organizations: string[] = [];
  const savedApplication = {
    id: process.env.THREADS_CLIENT_ID,
    secret: process.env.THREADS_CLIENT_SECRET,
    facebookId: process.env.FACEBOOK_CLIENT_ID,
    facebookSecret: process.env.FACEBOOK_CLIENT_SECRET,
  };
  const publisher = {
    platform: "threads",
    maxTextLength: 500,
    pollPolicy: policy,
    credentialsSchema: threadsCredentialsSchema,
    credentialTarget: () => "threads:12345",
    verify: vi.fn(),
    prepare: vi.fn(),
    inspect: vi.fn(),
    finalize: vi.fn(),
  };

  beforeAll(async () => {
    const parsed = url && new URL(url);
    if (
      !url ||
      !parsed ||
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
      !/^\/pubrick_.*_test$/.test(parsed.pathname)
    )
      throw new Error("A loopback disposable pubrick_*_test database is required");
    process.env.DATABASE_URL = url;
    process.env.THREADS_CLIENT_ID = "321";
    process.env.THREADS_CLIENT_SECRET = "fixture-app-secret";
    process.env.FACEBOOK_CLIENT_ID = "321";
    process.env.FACEBOOK_CLIENT_SECRET = "fixture-page-secret";
    const database = await import("@pubrick/db");
    await database.runMigrations(url);
    ({ pool } = await import("../db"));
    const { PgBoss } = await import("pg-boss");
    boss = new PgBoss({ connectionString: url, supervise: false, schedule: false });
    await boss.start();
    await boss.createQueue(queue, { retryLimit: 0, expireInSeconds: 600 });
    await boss.createQueue(`${ready}-dlq`);
    await boss.createQueue(ready, {
      ...META_PUBLICATION_QUEUE_OPTIONS,
      deadLetter: `${ready}-dlq`,
    });
    stages = new (await import("./staged-publication.repository")).StagedPublicationRepository();
    const receipts = new (await import("./publish.repository")).PublishRepository();
    const handler = new (await import("./staged-publication.service")).StagedPublicationService(
      stages,
      undefined,
      () => publisher as unknown as StagedPublisher<never>,
      { threads: { clientId: "321", clientSecret: "fixture-app-secret" } },
    );
    service = new (await import("./publish.service")).PublishService(
      receipts,
      undefined,
      undefined,
      0,
      handler,
    );
  }, 60_000);

  afterAll(async () => {
    if (pool) {
      await pool.query("DELETE FROM pgboss.job WHERE name=ANY($1::text[])", [
        [queue, ready, `${ready}-dlq`],
      ]);
      for (const orgId of organizations)
        await pool.query("DELETE FROM organization WHERE id=$1", [orgId]);
    }
    await boss?.stop({ graceful: false, timeout: 5000 });
    await pool?.end();
    if (savedApplication.id === undefined) delete process.env.THREADS_CLIENT_ID;
    else process.env.THREADS_CLIENT_ID = savedApplication.id;
    if (savedApplication.secret === undefined) delete process.env.THREADS_CLIENT_SECRET;
    else process.env.THREADS_CLIENT_SECRET = savedApplication.secret;
    if (savedApplication.facebookId === undefined) delete process.env.FACEBOOK_CLIENT_ID;
    else process.env.FACEBOOK_CLIENT_ID = savedApplication.facebookId;
    if (savedApplication.facebookSecret === undefined) delete process.env.FACEBOOK_CLIENT_SECRET;
    else process.env.FACEBOOK_CLIENT_SECRET = savedApplication.facebookSecret;
  });

  async function fixture() {
    vi.clearAllMocks();
    publisher.verify
      .mockReset()
      .mockResolvedValue({ ok: true, target: "threads:12345", account: "fixture_writer" });
    publisher.prepare.mockReset().mockResolvedValue({ containerId: "99887" });
    publisher.inspect.mockReset().mockResolvedValue({ status: "ready" });
    publisher.finalize.mockReset().mockResolvedValue(actualReceipt);
    const orgId = `meta-accept-${randomUUID()}`,
      brandId = randomUUID(),
      channelId = randomUUID(),
      itemId = randomUUID(),
      adaptationId = randomUUID();
    organizations.push(orgId);
    const { env } = await import("../env");
    const ciphertext = encryptJson(
      { accessToken: "fixture-token", accountId: "12345" },
      env.APP_ENCRYPTION_KEY,
    );
    await pool.query("INSERT INTO organization(id,name,slug) VALUES($1,'Fixture',$1)", [orgId]);
    await pool.query("INSERT INTO brands(id,org_id,name) VALUES($1,$2,'Fixture')", [
      brandId,
      orgId,
    ]);
    await pool.query(
      "INSERT INTO channels(id,org_id,brand_id,platform,name,credentials_encrypted,connection_target,connection_generation,connection_application_id) VALUES($1,$2,$3,'threads','Fixture',$4,'threads:12345',1,'321')",
      [channelId, orgId, brandId, ciphertext],
    );
    await pool.query(
      "INSERT INTO content_items(id,org_id,brand_id,body,status) VALUES($1,$2,$3,'Exact reviewed text','approved')",
      [itemId, orgId, brandId],
    );
    await pool.query(
      "INSERT INTO adaptations(id,org_id,content_item_id,channel_id,status) VALUES($1,$2,$3,$4,'queued')",
      [adaptationId, orgId, itemId, channelId],
    );
    const jobId = await boss.send(queue, { orgId, adaptationId });
    const [job] = await boss.fetch<{ orgId: string; adaptationId: string }>(queue, {
      includeMetadata: true,
    });
    if (!job || job.id !== jobId) throw new Error("Current fixture job was not fetched");
    const execution: Execution = {
      jobId: job.id,
      queue,
      startedOn: job.startedOn,
      retryCount: job.retryCount,
      readinessQueue: ready,
    };
    return {
      orgId,
      brandId,
      channelId,
      itemId,
      adaptationId,
      jobId: job.id,
      execution,
      payload: job.data,
    };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function saved(f: Fixture) {
    return {
      stages: (
        await pool.query(
          "SELECT * FROM meta_publication_stages WHERE org_id=$1 AND adaptation_id=$2 ORDER BY attempt",
          [f.orgId, f.adaptationId],
        )
      ).rows,
      receipts: (
        await pool.query(
          "SELECT * FROM publications WHERE org_id=$1 AND adaptation_id=$2 ORDER BY attempt",
          [f.orgId, f.adaptationId],
        )
      ).rows,
      adaptation: (
        await pool.query("SELECT * FROM adaptations WHERE org_id=$1 AND id=$2", [
          f.orgId,
          f.adaptationId,
        ])
      ).rows[0],
    };
  }
  async function waiting(f: Fixture, attempt = 1) {
    await service.handle(f.payload, boss, f.execution);
    const state = await saved(f);
    const currentStage = state.stages.find((stage) => stage.attempt === attempt);
    expect(currentStage).toMatchObject({
      phase: "waiting",
      attempt,
      container_id: "99887",
    });
    expect(state.receipts.filter((receipt) => receipt.attempt === attempt)).toHaveLength(0);
    expect(state.adaptation).toMatchObject({ status: "publishing", attempt_count: attempt });
    await boss.complete(queue, f.jobId);
    await pool.query(
      "UPDATE meta_publication_stages SET next_poll_at=clock_timestamp()-interval '1 second' WHERE org_id=$1 AND id=$2",
      [f.orgId, currentStage.id],
    );
    await pool.query(
      "UPDATE pgboss.job SET start_after=clock_timestamp()-interval '1 second' WHERE name=$1 AND data->>'orgId'=$2 AND data->>'stageId'=$3 AND state='created'",
      [ready, f.orgId, currentStage.id],
    );
    const [job] = await boss.fetch<{ orgId: string; adaptationId: string; stageId: string }>(
      ready,
      { includeMetadata: true },
    );
    if (!job || job.data.orgId !== f.orgId || job.data.stageId !== currentStage.id)
      throw new Error("Scoped readiness was not fetched");
    const execution: Execution = {
      jobId: job.id,
      queue: ready,
      startedOn: job.startedOn,
      retryCount: job.retryCount,
      readinessQueue: ready,
    };
    return { job: job.data, execution };
  }

  async function releaseJobAfterPostingWindow<T>(execution: Execution, action: () => Promise<T>) {
    const blocker = await pool.connect();
    let pending: Promise<T> | undefined;
    let settled = false;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM pgboss.job WHERE id=$1 FOR UPDATE", [execution.jobId]);
      pending = action();
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      const started = Date.now();
      for (;;) {
        const waiting = await pool.query(
          "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%pgboss.job%'",
        );
        if (waiting.rows.length) break;
        if (settled || Date.now() - started > 3000)
          throw new Error("The delivery did not reach its actual pg-boss lock wait");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await new Promise((resolve) => setTimeout(resolve, 2200));
    } finally {
      await blocker.query("COMMIT");
      blocker.release();
    }
    if (!pending) throw new Error("The delivery was not started");
    return pending;
  }

  it("persists preparation before CREATE, real final intent before PUBLISH, and one actual receipt on one attempt", async () => {
    const f = await fixture();
    publisher.prepare.mockImplementationOnce(async () => {
      const state = await saved(f);
      expect(state.stages[0]?.phase).toBe("preparation_intent");
      expect(state.receipts).toHaveLength(0);
      return { containerId: "99887" };
    });
    const poll = await waiting(f);
    publisher.finalize.mockImplementationOnce(async () => {
      const state = await saved(f);
      expect(state.stages[0]?.phase).toBe("final_intent");
      expect(state.receipts[0]).toMatchObject({ status: "in_flight", attempt: 1 });
      return actualReceipt;
    });
    await service.handleStaged(poll.job, boss, poll.execution);
    const state = await saved(f);
    expect(state.adaptation).toMatchObject({ status: "published", attempt_count: 1 });
    expect(state.stages[0]).toMatchObject({
      phase: "published",
      external_id: "55667",
      container_id: "99887",
      attempt: 1,
    });
    expect(state.receipts).toHaveLength(1);
    expect(state.receipts[0]).toMatchObject({
      status: "published",
      external_id: "55667",
      attempt: 1,
    });
    await service.handleStaged(poll.job, boss, poll.execution);
    expect(publisher.prepare).toHaveBeenCalledOnce();
    expect(publisher.finalize).toHaveBeenCalledOnce();
    expect((await saved(f)).receipts).toEqual(state.receipts);
  });

  it.each([
    "application",
    "credentials",
    "generation",
    "text",
    "cancelled",
    "expired-job",
    "old-retry",
    "old-start",
  ])("never admits preparation after a %s change during read-only proof", async (kind) => {
    const f = await fixture();
    publisher.verify.mockImplementationOnce(async () => {
      if (kind === "application")
        await pool.query("UPDATE channels SET connection_application_id='999' WHERE id=$1", [
          f.channelId,
        ]);
      if (kind === "credentials")
        await pool.query("UPDATE channels SET credentials_encrypted='replacement' WHERE id=$1", [
          f.channelId,
        ]);
      if (kind === "generation")
        await pool.query("UPDATE channels SET connection_generation=2 WHERE id=$1", [f.channelId]);
      if (kind === "text")
        await pool.query("UPDATE content_items SET body='Changed text' WHERE id=$1", [f.itemId]);
      if (kind === "cancelled")
        await pool.query("UPDATE adaptations SET status='pending' WHERE id=$1", [f.adaptationId]);
      if (kind === "expired-job") {
        await pool.query("UPDATE pgboss.job SET expire_seconds=1 WHERE id=$1", [f.jobId]);
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
      if (kind === "old-retry")
        await pool.query("UPDATE pgboss.job SET retry_count=retry_count+1 WHERE id=$1", [f.jobId]);
      if (kind === "old-start")
        await pool.query(
          "UPDATE pgboss.job SET started_on=started_on+interval '1 second' WHERE id=$1",
          [f.jobId],
        );
      return { ok: true, target: "threads:12345" };
    });
    await service.handle(f.payload, boss, f.execution);
    expect(publisher.prepare).not.toHaveBeenCalled();
    expect(publisher.finalize).not.toHaveBeenCalled();
    expect((await saved(f)).stages).toHaveLength(0);
    expect((await saved(f)).receipts).toHaveLength(0);
  });

  it.each([
    "application",
    "credentials",
    "generation",
    "text",
    "cancelled",
    "deadline",
    "expired-job",
    "old-retry",
    "old-start",
  ])("never finalizes after a %s change during readiness/permission reads", async (kind) => {
    const f = await fixture();
    const poll = await waiting(f);
    publisher.verify.mockImplementationOnce(async () => {
      if (kind === "application")
        await pool.query("UPDATE channels SET connection_application_id='999' WHERE id=$1", [
          f.channelId,
        ]);
      if (kind === "credentials")
        await pool.query("UPDATE channels SET credentials_encrypted='replacement' WHERE id=$1", [
          f.channelId,
        ]);
      if (kind === "generation")
        await pool.query("UPDATE channels SET connection_generation=2 WHERE id=$1", [f.channelId]);
      if (kind === "text")
        await pool.query("UPDATE content_items SET body='Changed text' WHERE id=$1", [f.itemId]);
      if (kind === "cancelled")
        await pool.query("UPDATE adaptations SET status='pending' WHERE id=$1", [f.adaptationId]);
      if (kind === "deadline")
        await pool.query(
          "UPDATE meta_publication_stages SET preparation_deadline=clock_timestamp()-interval '1 millisecond',created_at=clock_timestamp()-interval '1 hour' WHERE org_id=$1 AND adaptation_id=$2",
          [f.orgId, f.adaptationId],
        );
      if (kind === "expired-job") {
        await pool.query("UPDATE pgboss.job SET expire_seconds=1 WHERE id=$1", [
          poll.execution.jobId,
        ]);
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
      if (kind === "old-retry")
        await pool.query("UPDATE pgboss.job SET retry_count=retry_count+1 WHERE id=$1", [
          poll.execution.jobId,
        ]);
      if (kind === "old-start")
        await pool.query(
          "UPDATE pgboss.job SET started_on=started_on+interval '1 second' WHERE id=$1",
          [poll.execution.jobId],
        );
      return { ok: true, target: "threads:12345" };
    });
    await service.handleStaged(poll.job, boss, poll.execution);
    expect(publisher.finalize).not.toHaveBeenCalled();
    const state = await saved(f);
    expect(state.adaptation.status).not.toBe("published");
    expect(state.receipts.some((row) => row.status === "published")).toBe(false);
  });

  it("records the original saved slot as missed when DB time crosses its window during access proof", async () => {
    const f = await fixture();
    const { env } = await import("../env");
    await pool.query(
      "UPDATE adaptations SET status='scheduled',scheduled_at=clock_timestamp()-($2*interval '1 second')+interval '1 second' WHERE id=$1",
      [f.adaptationId, env.PUBLISH_MAX_LATENESS_HOURS * 3600],
    );
    publisher.verify.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return { ok: true, target: "threads:12345" };
    });
    await service.handle(f.payload, boss, f.execution);
    const state = await saved(f);
    expect(state.stages).toHaveLength(0);
    expect(state.adaptation).toMatchObject({ status: "failed", failure_reason: "schedule_missed" });
    expect(state.receipts[0]?.status).toBe("failed");
    expect(publisher.prepare).not.toHaveBeenCalled();
  });

  it("refuses final creation when the same saved slot crosses its window during permission proof", async () => {
    const f = await fixture();
    const { env } = await import("../env");
    await pool.query(
      "UPDATE adaptations SET status='scheduled',scheduled_at=clock_timestamp()-($2*interval '1 second')+interval '1 second' WHERE id=$1",
      [f.adaptationId, env.PUBLISH_MAX_LATENESS_HOURS * 3600],
    );
    const poll = await waiting(f);
    // Keep the independent container deadline valid so this case proves the current saved-slot bound itself.
    await pool.query(
      "UPDATE meta_publication_stages SET preparation_deadline=clock_timestamp()+interval '1 hour' WHERE org_id=$1 AND adaptation_id=$2",
      [f.orgId, f.adaptationId],
    );
    publisher.verify.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return { ok: true, target: "threads:12345" };
    });
    await service.handleStaged(poll.job, boss, poll.execution);
    expect(publisher.finalize).not.toHaveBeenCalled();
    expect((await saved(f)).receipts.some((row) => row.status === "published")).toBe(false);
  });

  it("keeps processing on the same attempt and queues only its private readiness destination", async () => {
    const f = await fixture();
    const poll = await waiting(f);
    publisher.inspect.mockResolvedValueOnce({ status: "processing" });
    await service.handleStaged(poll.job, boss, poll.execution);
    const state = await saved(f);
    expect(state.stages[0]).toMatchObject({ phase: "waiting", attempt: 1, poll_count: 1 });
    expect(state.receipts).toHaveLength(0);
    const jobs = await pool.query(
      "SELECT name FROM pgboss.job WHERE state<'completed'::pgboss.job_state AND data->>'orgId'=$1",
      [f.orgId],
    );
    expect(jobs.rows.every((row) => row.name === ready)).toBe(true);
    expect(publisher.prepare).toHaveBeenCalledOnce();
    expect(publisher.finalize).not.toHaveBeenCalled();
  });

  it("retains late preparation receipt but cannot enqueue readiness after its original job expires", async () => {
    const f = await fixture();
    publisher.prepare.mockImplementationOnce(async () => {
      await pool.query("UPDATE pgboss.job SET expire_seconds=1 WHERE id=$1", [f.jobId]);
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return { containerId: "99887" };
    });
    await service.handle(f.payload, boss, f.execution);
    expect((await saved(f)).stages[0]).toMatchObject({
      phase: "preparation_unknown",
      container_id: "99887",
    });
    expect(
      (
        await pool.query("SELECT id FROM pgboss.job WHERE name=$1 AND data->>'orgId'=$2", [
          ready,
          f.orgId,
        ])
      ).rows,
    ).toHaveLength(0);
    expect(publisher.finalize).not.toHaveBeenCalled();
  });

  it("retains the container but refuses readiness after the encrypted grant changes during preparation", async () => {
    const f = await fixture();
    publisher.prepare.mockImplementationOnce(async () => {
      await pool.query("UPDATE channels SET credentials_encrypted='replacement' WHERE id=$1", [
        f.channelId,
      ]);
      return { containerId: "99887" };
    });
    await service.handle(f.payload, boss, f.execution);
    expect((await saved(f)).stages[0]).toMatchObject({
      phase: "cancelled",
      container_id: "99887",
    });
    expect(
      (
        await pool.query("SELECT id FROM pgboss.job WHERE name=$1 AND data->>'orgId'=$2", [
          ready,
          f.orgId,
        ])
      ).rows,
    ).toHaveLength(0);
    expect(publisher.finalize).not.toHaveBeenCalled();
  });

  it("does not enqueue another poll after the encrypted grant changes during processing", async () => {
    const f = await fixture();
    const poll = await waiting(f);
    publisher.inspect.mockImplementationOnce(async () => {
      await pool.query("UPDATE channels SET credentials_encrypted='replacement' WHERE id=$1", [
        f.channelId,
      ]);
      return { status: "processing" };
    });
    await service.handleStaged(poll.job, boss, poll.execution);
    const jobs = await pool.query("SELECT id FROM pgboss.job WHERE name=$1 AND data->>'orgId'=$2", [
      ready,
      f.orgId,
    ]);
    expect(jobs.rows).toEqual([{ id: poll.execution.jobId }]);
    expect(publisher.finalize).not.toHaveBeenCalled();
  });

  it("recovers an orphaned waiting container on its original attempt and private queue using the DB clock", async () => {
    const f = await fixture();
    const poll = await waiting(f);
    await boss.complete(ready, poll.execution.jobId);
    await service.recoverStaged(f.orgId, boss, ready);
    const state = await saved(f);
    expect(state.stages).toHaveLength(1);
    expect(state.stages[0]).toMatchObject({ phase: "waiting", attempt: 1, container_id: "99887" });
    expect(state.adaptation).toMatchObject({ status: "publishing", attempt_count: 1 });
    const [resumed] = await boss.fetch(ready, { includeMetadata: true });
    expect(resumed?.data).toEqual(poll.job);
    expect(resumed?.id).not.toBe(poll.execution.jobId);
    expect(publisher.prepare).toHaveBeenCalledOnce();
    expect(publisher.finalize).not.toHaveBeenCalled();
  });

  it.each(["preparation", "processing"])(
    "does not enqueue %s work when the saved posting window expires during the actual job lock wait",
    async (kind) => {
      const f = await fixture();
      const { env } = await import("../env");
      await pool.query(
        "UPDATE adaptations SET status='scheduled',scheduled_at=clock_timestamp()-($2*interval '1 second')+interval '2 seconds' WHERE id=$1",
        [f.adaptationId, env.PUBLISH_MAX_LATENESS_HOURS * 3600],
      );
      // Keep the separate container deadline valid to isolate the fresh DB posting-window proof.
      const extendDeadline = () =>
        pool.query(
          "UPDATE meta_publication_stages SET preparation_deadline=clock_timestamp()+interval '1 hour' WHERE org_id=$1 AND adaptation_id=$2",
          [f.orgId, f.adaptationId],
        );
      if (kind === "preparation") {
        const original = stages.prepared.bind(stages);
        const spy = vi.spyOn(stages, "prepared").mockImplementationOnce(async (...args) => {
          await extendDeadline();
          return releaseJobAfterPostingWindow(f.execution, () => original(...args));
        });
        try {
          await service.handle(f.payload, boss, f.execution);
        } finally {
          spy.mockRestore();
        }
        expect((await saved(f)).stages[0]).toMatchObject({
          phase: "cancelled",
          container_id: "99887",
        });
      } else {
        const poll = await waiting(f);
        publisher.inspect.mockResolvedValueOnce({ status: "processing" });
        const original = stages.defer.bind(stages);
        const spy = vi.spyOn(stages, "defer").mockImplementationOnce(async (...args) => {
          await extendDeadline();
          return releaseJobAfterPostingWindow(poll.execution, () => original(...args));
        });
        try {
          await service.handleStaged(poll.job, boss, poll.execution);
        } finally {
          spy.mockRestore();
        }
      }
      const jobs = await pool.query(
        "SELECT id FROM pgboss.job WHERE name=$1 AND data->>'orgId'=$2",
        [ready, f.orgId],
      );
      expect(jobs.rows).toHaveLength(kind === "preparation" ? 0 : 1);
      expect(publisher.finalize).not.toHaveBeenCalled();
    },
  );

  it("holds actual final uncertainty without automatically creating or publishing again", async () => {
    const f = await fixture();
    const poll = await waiting(f);
    publisher.finalize.mockRejectedValueOnce(
      new UnknownOutcomePublishError("fixture lost receipt"),
    );
    await service.handleStaged(poll.job, boss, poll.execution);
    await service.handleStaged(poll.job, boss, poll.execution);
    const state = await saved(f);
    expect(state.stages[0]?.phase).toBe("final_unknown");
    expect(state.receipts[0]?.status).toBe("unknown");
    expect(publisher.finalize).toHaveBeenCalledOnce();
    expect(publisher.prepare).toHaveBeenCalledOnce();
  });

  it.each([
    "unchanged",
    "application",
    "credentials",
    "generation",
    "text",
    "cancelled",
    "old-start",
    "old-retry",
    "foreign-job",
    "expired-job",
  ])("admits the direct Facebook CREATE only under %s current authority", async (kind) => {
    const f = await fixture();
    const { env } = await import("../env");
    const pageBag = encryptJson(
      { accessToken: "fixture-page-token", userAccessToken: "fixture-user-token", pageId: "777" },
      env.APP_ENCRYPTION_KEY,
    );
    await pool.query(
      "UPDATE channels SET platform='facebook_page',connection_target='facebook-page:777',credentials_encrypted=$2 WHERE id=$1",
      [f.channelId, pageBag],
    );
    const repo = new (await import("./publish.repository")).PublishRepository();
    const snapshot = await repo.managedCredentialSnapshot(f.orgId, f.channelId, "facebook_page");
    const attempt = await repo.markPublishing(f.orgId, f.adaptationId, null);
    expect(attempt).toBe(1);
    const claim = await repo.claimSend(f.orgId, f.adaptationId, 1);
    if (!claim) throw new Error("Claim unavailable");
    if (kind === "application")
      await pool.query("UPDATE channels SET connection_application_id='999' WHERE id=$1", [
        f.channelId,
      ]);
    if (kind === "credentials")
      await pool.query("UPDATE channels SET credentials_encrypted='replacement' WHERE id=$1", [
        f.channelId,
      ]);
    if (kind === "generation")
      await pool.query("UPDATE channels SET connection_generation=2 WHERE id=$1", [f.channelId]);
    if (kind === "text")
      await pool.query("UPDATE content_items SET body='Changed text' WHERE id=$1", [f.itemId]);
    if (kind === "cancelled")
      await pool.query("UPDATE adaptations SET status='pending' WHERE id=$1", [f.adaptationId]);
    if (kind === "old-start")
      await pool.query(
        "UPDATE pgboss.job SET started_on=started_on+interval '1 second' WHERE id=$1",
        [f.jobId],
      );
    if (kind === "old-retry")
      await pool.query("UPDATE pgboss.job SET retry_count=retry_count+1 WHERE id=$1", [f.jobId]);
    if (kind === "foreign-job")
      await pool.query(
        "UPDATE pgboss.job SET data=jsonb_set(data,'{orgId}','\"other\"'::jsonb) WHERE id=$1",
        [f.jobId],
      );
    if (kind === "expired-job") {
      await pool.query("UPDATE pgboss.job SET expire_seconds=1 WHERE id=$1", [f.jobId]);
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    expect(
      await repo.facebookPageSendCurrent(
        f.orgId,
        f.adaptationId,
        claim,
        { ...snapshot, text: "Exact reviewed text", scheduledAt: null },
        f.execution,
      ),
    ).toBe(kind === "unchanged");
  });

  it("retains a provider-accepted record under the original final claim without resending", async () => {
    const f = await fixture();
    const poll = await waiting(f);
    publisher.finalize.mockRejectedValueOnce(
      new AcceptedPublicationError("Fixture provider accepted a pending record", actualReceipt),
    );
    await service.handleStaged(poll.job, boss, poll.execution);
    await service.handleStaged(poll.job, boss, poll.execution);
    const state = await saved(f);
    expect(state.stages[0]).toMatchObject({ phase: "final_unknown", external_id: "55667" });
    expect(state.receipts).toHaveLength(1);
    expect(state.receipts[0]).toMatchObject({
      status: "unknown",
      external_id: "55667",
      attempt: 1,
    });
    expect(publisher.finalize).toHaveBeenCalledOnce();
    expect(publisher.prepare).toHaveBeenCalledOnce();
  });

  it.each([
    "human",
    "worker",
    "wrong-attempt",
    "tie",
    "wrong-final-claim",
    "later-unknown",
    "known-failed",
  ])("binds a new staged attempt to %s historical final resolution", async (kind) => {
    const f = await fixture();
    const poll = await waiting(f);
    const acquisition = vi.spyOn(stages, "acquire");
    publisher.finalize.mockRejectedValueOnce(
      kind === "known-failed"
        ? new PermanentPublishError("Fixture known final refusal")
        : new UnknownOutcomePublishError("Fixture final receipt lost"),
    );
    let oldLease: Awaited<ReturnType<StageRepository["acquire"]>>;
    try {
      await service.handleStaged(poll.job, boss, poll.execution);
      oldLease = await acquisition.mock.results[0]?.value;
    } finally {
      acquisition.mockRestore();
    }
    if (!oldLease) throw new Error("The old final attempt is missing");
    await boss.complete(ready, poll.execution.jobId);
    const old = await saved(f);
    const claim = { id: old.receipts[0].id as string, attempt: 1 };
    expect(old.stages[0].phase).toBe(kind === "known-failed" ? "failed" : "final_unknown");
    if (kind === "wrong-final-claim")
      // A human can resolve only the latest viewed receipt, not a different retained final claim.
      await pool.query(
        "insert into publications(org_id,adaptation_id,channel_id,status,attempt,created_at) values($1,$2,$3,'unknown',1,clock_timestamp())",
        [f.orgId, f.adaptationId, f.channelId],
      );
    if (kind !== "known-failed") {
      await pool.query(
        "insert into publications(org_id,adaptation_id,channel_id,status,attempt,asserted_at,created_at) select org_id,adaptation_id,channel_id,'failed',$2,case when $3 then null else clock_timestamp() end,case when $4 then created_at else clock_timestamp() end from publications where org_id=$1 and id=$5",
        [f.orgId, kind === "wrong-attempt" ? 2 : 1, kind === "worker", kind === "tie", claim.id],
      );
    }
    if (kind === "later-unknown")
      await pool.query(
        "insert into publications(org_id,adaptation_id,channel_id,status,attempt,created_at) values($1,$2,$3,'unknown',1,clock_timestamp())",
        [f.orgId, f.adaptationId, f.channelId],
      );
    // A separate approval is the only source of the next job. The real HTTP path is pinned by API acceptance.
    await pool.query("update adaptations set status='queued' where org_id=$1 and id=$2", [
      f.orgId,
      f.adaptationId,
    ]);
    await pool.query("update content_items set status='approved' where org_id=$1 and id=$2", [
      f.orgId,
      f.itemId,
    ]);
    const nextId = await boss.send(queue, f.payload);
    const [job] = await boss.fetch<{ orgId: string; adaptationId: string }>(queue, {
      includeMetadata: true,
    });
    if (!job || job.id !== nextId) throw new Error("The approved new job is missing");
    const next: Fixture = {
      ...f,
      jobId: job.id,
      payload: job.data,
      execution: {
        jobId: job.id,
        queue,
        startedOn: job.startedOn,
        retryCount: job.retryCount,
        readinessQueue: ready,
      },
    };
    if (kind === "human" || kind === "known-failed") {
      const nextPoll = await waiting(next, 2);
      await service.handleStaged(nextPoll.job, boss, nextPoll.execution);
      const published = await saved(f);
      expect(published.stages[1]).toMatchObject({
        phase: "published",
        attempt: 2,
        external_id: "55667",
      });
      expect(published.adaptation).toMatchObject({ status: "published", attempt_count: 2 });
      expect(published.stages[0]).toEqual(old.stages[0]);
      expect(published.receipts.find((receipt) => receipt.id === claim.id)).toEqual(
        old.receipts[0],
      );
      if (kind === "human") {
        const receiptRepo = new (await import("./publish.repository")).PublishRepository();
        const late = { externalId: "55660", externalUrl: null };
        await receiptRepo.markAcceptedPublication(
          f.orgId,
          f.adaptationId,
          "Late old evidence",
          { status: "publishing", attemptCount: 1 },
          late,
          claim,
        );
        await stages.retainReceipt(f.orgId, oldLease, claim, late, false);
        const after = await saved(f);
        expect(after.adaptation).toEqual(published.adaptation);
        expect(after.stages[1]).toEqual(published.stages[1]);
        expect(after.receipts.find((receipt) => receipt.attempt === 2)).toEqual(
          published.receipts.find((receipt) => receipt.attempt === 2),
        );
        expect(after.stages[0]).toMatchObject({ phase: "final_unknown", external_id: "55660" });
      }
    } else {
      await service.handle(next.payload, boss, next.execution);
      expect((await saved(f)).stages).toHaveLength(1);
      expect(publisher.prepare).toHaveBeenCalledOnce();
      expect(publisher.finalize).toHaveBeenCalledOnce();
    }
  });

  it("honors explicit discarded preparation and keeps old late evidence outside the new approved attempt", async () => {
    const f = await fixture();
    const admission = vi.spyOn(stages, "begin");
    publisher.prepare.mockRejectedValueOnce(
      new UnknownPreparationError("Fixture lost preparation receipt"),
    );
    await service.handle(f.payload, boss, f.execution);
    const old = await admission.mock.results[0]?.value;
    admission.mockRestore();
    if (!old) throw new Error("Missing old admission");
    expect((await saved(f)).stages[0]?.phase).toBe("preparation_unknown");
    await boss.complete(queue, f.jobId);
    // Represents the API's acknowledged no-final/no-live-job discard transaction, with no automatic admission.
    await pool.query(
      "UPDATE meta_publication_stages SET phase='cancelled',updated_at=clock_timestamp() WHERE org_id=$1 AND id=$2 AND phase='preparation_unknown'",
      [f.orgId, old.id],
    );
    expect(await stages.prepared(f.orgId, old, "99887", policy, boss)).toBe(false);
    expect((await saved(f)).stages[0]).toMatchObject({
      phase: "cancelled",
      container_id: "99887",
      attempt: 1,
    });
    expect(
      (
        await pool.query("SELECT id FROM pgboss.job WHERE name=$1 AND data->>'orgId'=$2", [
          ready,
          f.orgId,
        ])
      ).rows,
    ).toHaveLength(0);
    // A separate human review/approval creates the only new job. The next stage owns the next attempt.
    await pool.query("UPDATE adaptations SET status='queued' WHERE org_id=$1 AND id=$2", [
      f.orgId,
      f.adaptationId,
    ]);
    await pool.query("UPDATE content_items SET status='approved' WHERE org_id=$1 AND id=$2", [
      f.orgId,
      f.itemId,
    ]);
    const newId = await boss.send(queue, f.payload);
    const [job] = await boss.fetch<{ orgId: string; adaptationId: string }>(queue, {
      includeMetadata: true,
    });
    if (!job || job.id !== newId) throw new Error("Missing new approved job");
    publisher.prepare.mockResolvedValueOnce({ containerId: "99889" });
    await service.handle(job.data, boss, {
      jobId: job.id,
      queue,
      startedOn: job.startedOn,
      retryCount: job.retryCount,
      readinessQueue: ready,
    });
    const current = await saved(f);
    expect(current.stages).toHaveLength(2);
    expect(current.stages[1]).toMatchObject({
      phase: "waiting",
      container_id: "99889",
      attempt: 2,
    });
    expect(await stages.prepared(f.orgId, old, "77777", policy, boss)).toBe(false);
    const after = await saved(f);
    expect(after.stages[1]).toEqual(current.stages[1]);
    expect(after.adaptation).toEqual(current.adaptation);
    expect(after.stages[0]).toMatchObject({ phase: "cancelled", container_id: "99887" });
  });

  it("requires the exact scoped readiness job payload and refuses a foreign organization's stage", async () => {
    const f = await fixture();
    const poll = await waiting(f);
    await service.handleStaged({ ...poll.job, orgId: "foreign" }, boss, poll.execution);
    expect(publisher.inspect).not.toHaveBeenCalled();
    expect(publisher.finalize).not.toHaveBeenCalled();
    expect((await saved(f)).stages[0]?.phase).toBe("waiting");
  });
});
