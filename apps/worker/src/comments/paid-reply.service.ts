import { Injectable, Logger } from "@nestjs/common";
import { generatePaidReply } from "@pubrick/ai";
import type { PaidReplyAnalysisJob } from "@pubrick/shared";
import type { PgBoss } from "pg-boss";
import { PaidReplyRepository } from "./paid-reply.repository";

@Injectable()
export class PaidReplyService {
  private readonly logger = new Logger(PaidReplyService.name);
  constructor(private readonly replies: PaidReplyRepository) {}

  reconcile(boss: PgBoss, start: Date): Promise<number> {
    return this.replies.reconcile(boss, start);
  }

  sweep(boss: PgBoss): Promise<void> {
    return this.replies.sweep(boss);
  }

  async handle(job: PaidReplyAnalysisJob): Promise<void> {
    const claim = await this.replies.claim(job);
    if (!claim) return;
    let metered = false;
    try {
      const result = await generatePaidReply(
        claim.request,
        claim.apiKey,
        async (usage) => {
          await this.replies.recordUsage(job, usage);
          metered = true;
        },
        undefined,
        claim.proxyUrl,
      );
      await this.replies.finish(job, result);
    } catch {
      // The request may have reached Google. Keep the one-call fence and the
      // reservation even if both the ledger and loss marker are unavailable.
      if (!metered) {
        try {
          await this.replies.markUnrecorded(job);
        } catch {
          this.logger.error(`Paid reply metering unavailable for attempt ${job.attemptId}`);
        }
      }
      try {
        await this.replies.finish(job, null);
      } catch {
        this.logger.error(`Paid reply attempt ${job.attemptId} awaits recovery sweep`);
      }
    }
  }
}
