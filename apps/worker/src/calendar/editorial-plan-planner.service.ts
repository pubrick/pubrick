import { Injectable } from "@nestjs/common";
import { EditorialPlanPersistenceError, EditorialPlansPersistence, schema } from "@pubrick/db";
import type { EditorialPlanJob } from "@pubrick/shared";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { db } from "../db";

const PAGE_SIZE = 100;
const MAX_PAGES_PER_SCAN = 4;
@Injectable()
export class EditorialPlanPlannerService {
  private cursor: string | undefined;
  private readonly plans = new EditorialPlansPersistence(db);
  /** Global discovery only; each plan uses the shared tenant-scoped quota transaction. */
  async scan(now = new Date()): Promise<void> {
    for (let page = 0; page < MAX_PAGES_PER_SCAN; page++) {
      const rows = await db
        .select({
          id: schema.editorialPlans.id,
          orgId: schema.editorialPlans.orgId,
          brandId: schema.editorialPlans.brandId,
        })
        .from(schema.editorialPlans)
        .where(
          and(
            eq(schema.editorialPlans.enabled, true),
            isNull(schema.editorialPlans.removedAt),
            this.cursor ? gt(schema.editorialPlans.id, this.cursor) : undefined,
          ),
        )
        .orderBy(asc(schema.editorialPlans.id))
        .limit(PAGE_SIZE);
      for (const row of rows) {
        await this.handle({ orgId: row.orgId, brandId: row.brandId, planId: row.id }, now);
        this.cursor = row.id;
      }
      if (rows.length < PAGE_SIZE) {
        this.cursor = undefined;
        return;
      }
    }
  }
  async handle(job: EditorialPlanJob, now = new Date()): Promise<void> {
    try {
      await this.plans.materialize(job.orgId, job.brandId, job.planId, now);
    } catch (error) {
      if (error instanceof EditorialPlanPersistenceError && error.code === "not_found") return;
      throw error;
    }
  }
}
