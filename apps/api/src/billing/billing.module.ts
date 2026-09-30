import { type DynamicModule, Logger, Module } from "@nestjs/common";
import type { createDb } from "@pubrick/db";
import type { BillingConfig } from "./billing.config";
import { BillingController, PublicBillingController } from "./billing.controller";
import { BillingRepository } from "./billing.repository";
import { BillingService } from "./billing.service";
import { BillingRuntime, createBillingRuntime } from "./billing-runtime";

export const BILLING_DATABASE = Symbol("BILLING_DATABASE");
type Database = ReturnType<typeof createDb>["db"];
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest requires a decorated dynamic module class.
export class BillingModule {
  static forRoot(config: BillingConfig, database?: Database): DynamicModule {
    if (!config.enabled) return { module: BillingModule };
    return {
      module: BillingModule,
      controllers: [BillingController, PublicBillingController],
      providers: [
        {
          provide: BILLING_DATABASE,
          useFactory: async () => database ?? (await import("../db")).db,
        },
        {
          provide: BillingRepository,
          inject: [BILLING_DATABASE],
          useFactory: (db: Database) => new BillingRepository(db, config.identity),
        },
        {
          provide: BillingRuntime,
          inject: [BillingRepository],
          useFactory: (repository: BillingRepository) =>
            createBillingRuntime(config, repository, {
              report: (code) => new Logger("BillingRuntime").error(code),
            }),
        },
        {
          provide: BillingService,
          inject: [BillingRuntime],
          useFactory: (runtime: BillingRuntime) => runtime.service,
        },
      ],
      exports: [BillingService, BillingRepository, BillingRuntime],
    };
  }
}
