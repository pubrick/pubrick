import { NestFactory } from "@nestjs/core";
import { runMigrations } from "@pubrick/db";
import { AppModule } from "./app.module";
import { pool } from "./db";
import { env } from "./env";
import { closeApi } from "./shutdown";

async function bootstrap(): Promise<void> {
  await runMigrations(env.DATABASE_URL);
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.setGlobalPrefix("api");
  await app.listen(env.API_PORT);
  console.log(`api listening on :${env.API_PORT}`);

  // Mirrors apps/worker/src/main.ts. Without this, `docker compose up -d
  // --build` — the self-hosting doc's own upgrade command — sends SIGTERM to
  // a process with no handler for it, and the container runtime kills every
  // in-flight query out from under the pool instead of letting closeApi()
  // drain it. See shutdown.ts for what draining actually means here.
  const shutdown = async (): Promise<void> => {
    await closeApi(app, pool);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
