import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("claim correction proposal persistence", () => {
  let pool: pg.Pool;
  const orgId = `correction-${randomUUID()}`;
  const otherOrgId = `correction-${randomUUID()}`;
  const body = "The museum opened in 2024.";
  const hash = createHash("sha256").update(body).digest("hex");
  const evidence = [
    {
      title: "Museum archive",
      url: "https://example.org/archive",
      snippet: "The museum opened in 2023.",
    },
  ];
  let itemId: string;
  let reviewId: string;

  beforeAll(async () => {
    await runMigrations(url as string);
    pool = new pg.Pool({ connectionString: url });
    for (const id of [orgId, otherOrgId]) {
      await pool.query(
        "INSERT INTO organization (id, name, slug) VALUES ($1, 'Correction test', $1)",
        [id],
      );
    }
    const brand = await pool.query<{ id: string }>(
      "INSERT INTO brands (org_id, name) VALUES ($1, 'Brand') RETURNING id",
      [orgId],
    );
    const item = await pool.query<{ id: string }>(
      "INSERT INTO content_items (org_id, brand_id, body) VALUES ($1, $2, $3) RETURNING id",
      [orgId, brand.rows[0]?.id, body],
    );
    itemId = item.rows[0]?.id as string;
    const review = await pool.query<{ id: string }>(
      `INSERT INTO claim_reviews (org_id, content_item_id, body_hash, status, claims, completed_at)
       VALUES ($1, $2, $3, 'ready', $4, now()) RETURNING id`,
      [
        orgId,
        itemId,
        hash,
        JSON.stringify([{ claim: body, outcome: "evidence_conflicts", evidence }]),
      ],
    );
    reviewId = review.rows[0]?.id as string;
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query("DELETE FROM organization WHERE id = ANY($1)", [[orgId, otherOrgId]]);
    await pool.end();
  });

  async function insert(overrides: Record<string, unknown> = {}) {
    const values = {
      orgId,
      itemId,
      reviewId,
      hash,
      claimIndex: 0,
      sourceBody: body,
      claim: body,
      replacement: "The museum opened in 2023.",
      reason: "The cited archive gives a different year.",
      evidence,
      ...overrides,
    };
    return pool.query<{ id: string }>(
      `INSERT INTO claim_correction_proposals
       (org_id, content_item_id, review_id, claim_index, source_body, source_body_hash,
        claim, replacement, reason, evidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        values.orgId,
        values.itemId,
        values.reviewId,
        values.claimIndex,
        values.sourceBody,
        values.hash,
        values.claim,
        values.replacement,
        values.reason,
        JSON.stringify(values.evidence),
      ],
    );
  }

  it("rejects cross-tenant, altered, uncited and non-conflicting proposals", async () => {
    await expect(insert({ orgId: otherOrgId })).rejects.toMatchObject({ code: "23514" });
    await expect(insert({ hash: "a".repeat(64) })).rejects.toMatchObject({ code: "23514" });
    await expect(insert({ sourceBody: `${body} More text.` })).rejects.toMatchObject({
      code: "23514",
    });
    await expect(insert({ claimIndex: 1 })).rejects.toMatchObject({ code: "23514" });
    await expect(insert({ claim: "A made-up claim" })).rejects.toMatchObject({ code: "23514" });
    await expect(
      insert({ evidence: [{ ...evidence[0], snippet: "Invented" }] }),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("stages once, rejects mutation, and cascades with its item", async () => {
    const proposal = await insert();
    const id = proposal.rows[0]?.id;
    expect(id).toBeDefined();
    await expect(insert()).rejects.toMatchObject({ code: "23505" });
    await expect(
      pool.query("UPDATE claim_correction_proposals SET reason = 'Changed' WHERE id = $1", [id]),
    ).rejects.toMatchObject({ code: "23514" });
    await pool.query("DELETE FROM content_items WHERE id = $1", [itemId]);
    const remaining = await pool.query("SELECT id FROM claim_correction_proposals WHERE id = $1", [
      id,
    ]);
    expect(remaining.rows).toEqual([]);
  });
});
