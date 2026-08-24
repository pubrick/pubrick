import { Injectable, Logger } from "@nestjs/common";
import type { PgBoss } from "pg-boss";

@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);

  /** Seam for job registration; later plans add real queues alongside heartbeat. */
  async registerHeartbeat(boss: PgBoss): Promise<void> {
    await boss.createQueue("heartbeat");
    await boss.schedule("heartbeat", "* * * * *");
    await boss.work("heartbeat", async () => {
      this.logger.log("heartbeat");
    });
  }
}
