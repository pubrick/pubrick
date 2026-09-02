import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { PgBoss } from "pg-boss";
import { pool } from "./db";
import { env } from "./env";
import { PUBLISH_STOP_TIMEOUT_MS } from "./publish/publish.service";
import { QueueService } from "./queue.service";
import { WorkerModule } from "./worker.module";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  const boss = new PgBoss(env.DATABASE_URL);
  boss.on("error", (err: Error) => console.error("pg-boss error", err));
  await boss.start();
  await app.get(QueueService).registerAll(boss);
  console.log("worker started");

  const shutdown = async (): Promise<void> => {
    // NOT pg-boss's 30s default. That default is exactly the publish adapter's
    // own request timeout, so a send that started a moment before SIGTERM is
    // guaranteed to be still in flight when `failWip()` fails its job — and a
    // failed job is a redelivered job, which is a second post. The window is
    // derived from the adapter's timeout plus the recording budget; see
    // PUBLISH_STOP_TIMEOUT_MS for why, and for why it is only defence in depth.
    await boss.stop({ graceful: true, timeout: PUBLISH_STOP_TIMEOUT_MS });
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

void bootstrap();
