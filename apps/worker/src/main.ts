import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { PgBoss } from "pg-boss";
import { env } from "./env";
import { QueueService } from "./queue.service";
import { WorkerModule } from "./worker.module";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  const boss = new PgBoss(env.DATABASE_URL);
  boss.on("error", (err: Error) => console.error("pg-boss error", err));
  await boss.start();
  await app.get(QueueService).registerHeartbeat(boss);
  console.log("worker started");

  const shutdown = async (): Promise<void> => {
    await boss.stop({ graceful: true });
    await app.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

void bootstrap();
