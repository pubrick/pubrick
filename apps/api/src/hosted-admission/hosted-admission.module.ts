import { type DynamicModule, Module } from "@nestjs/common";
import { authorizeBillingGrowth, HostedAdmissionRepository } from "@pubrick/db";
import type { BillingConfig } from "../billing/billing.config";
import { BillingModule } from "../billing/billing.module";
import { BillingRepository } from "../billing/billing.repository";
import { QueueService } from "../queue/queue.service";
import { HostedAdmissionController } from "./hosted-admission.controller";
import { HostedAdmissionService } from "./hosted-admission.service";

@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: Nest dynamic module composition.
export class HostedAdmissionModule {
  static forRoot(config: BillingConfig): DynamicModule {
    if (!config.enabled) return { module: HostedAdmissionModule };
    return {
      module: HostedAdmissionModule,
      imports: [BillingModule.forRoot(config)],
      controllers: [HostedAdmissionController],
      providers: [
        {
          provide: HostedAdmissionService,
          inject: [BillingRepository, QueueService],
          useFactory: async (billing: BillingRepository, queue: QueueService) => {
            const { db } = await import("../db");
            return new HostedAdmissionService(
              new HostedAdmissionRepository(
                db,
                {
                  maxOwnedWorkspaces: config.accountPolicy.maxOwnedWorkspaces,
                  maxCreationsPerDay: config.accountPolicy.maxCreatesPerDay,
                },
                {
                  authorizeGrowth: async (tx, input) => {
                    // Creating an empty workspace grants no paid resources or initial trial.
                    if (input.operation === "create") return;
                    await authorizeBillingGrowth(input.orgId, tx, config.identity, {
                      resource: "seats",
                      occupied: input.occupiedSeats,
                      additional: input.additionalSeats,
                    });
                  },
                  enqueueInvitation: async (tx, input) => {
                    const link = new URL(`/${input.locale}/onboarding`, config.publicOrigin);
                    link.searchParams.set("invitation", input.invitationId);
                    await queue.enqueueInvitation(tx, {
                      kind: "invite",
                      invitationId: input.invitationId,
                      organizationId: input.organizationId,
                      recipient: input.email,
                      locale: input.locale,
                      link: link.href,
                    });
                  },
                  stageDeletion: (tx, input) => billing.tombstoneInTx(input.orgId, tx),
                },
              ),
            );
          },
        },
      ],
      exports: [HostedAdmissionService],
    };
  }
}
