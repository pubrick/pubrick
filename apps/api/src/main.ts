import { NestFactory } from "@nestjs/core";
import { runMigrations } from "@pubrick/db";
import { AppModule } from "./app.module";
import { env } from "./env";

async function bootstrap(): Promise<void> {
  await runMigrations(env.DATABASE_URL);
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix("api");
  await app.listen(env.API_PORT);
  console.log(`api listening on :${env.API_PORT}`);
}

void bootstrap();
