import { Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import {
  AuthMailError,
  createMailIdentity,
  createSmtpMailTransport,
  openAuthMail,
  verificationMailDeadline,
} from "@pubrick/mail";
import {
  AUTH_MAIL_DLQ,
  AUTH_MAIL_DLQ_OPTIONS,
  AUTH_MAIL_QUEUE,
  AUTH_MAIL_QUEUE_OPTIONS,
  AUTH_MAIL_WORK_OPTIONS,
  type AuthMailJob,
} from "@pubrick/shared";
import type { Job, JobResult, PgBoss } from "pg-boss";
import { env, mailConfig } from "../env";
import { AuthMailRepository } from "./auth-mail.repository";
@Injectable()
export class AuthMailService implements OnModuleDestroy {
  private readonly logger = new Logger(AuthMailService.name);
  private readonly transport;
  readonly enabled = !!mailConfig;
  constructor(private readonly repository: AuthMailRepository) {
    if (mailConfig) {
      if (!env.BETTER_AUTH_SECRET) throw new AuthMailError("configuration");
      const runtime =
        process.env.NODE_ENV === "production"
          ? "production"
          : process.env.NODE_ENV === "test"
            ? "test"
            : "development";
      this.transport = createSmtpMailTransport(mailConfig, {
        identity: createMailIdentity(
          env.WEB_ORIGIN,
          env.PUBRICK_DEPLOYMENT_MODE,
          env.BETTER_AUTH_SECRET,
        ),
        runtime,
      });
    }
  }
  async register(
    boss: PgBoss,
    names = { queue: AUTH_MAIL_QUEUE, deadLetter: AUTH_MAIL_DLQ },
  ): Promise<void> {
    if (!this.enabled) return;
    await boss.createQueue(names.deadLetter, { ...AUTH_MAIL_DLQ_OPTIONS });
    await boss.updateQueue(names.deadLetter, { ...AUTH_MAIL_DLQ_OPTIONS });
    await boss.createQueue(names.queue, {
      ...AUTH_MAIL_QUEUE_OPTIONS,
      deadLetter: names.deadLetter,
    });
    await boss.updateQueue(names.queue, {
      ...AUTH_MAIL_QUEUE_OPTIONS,
      deadLetter: names.deadLetter,
    });
    await boss.work<AuthMailJob>(names.queue, { ...AUTH_MAIL_WORK_OPTIONS }, async (jobs) =>
      Promise.all(jobs.map((job) => this.handle(job))),
    );
    await boss.work<AuthMailJob>(names.deadLetter, { batchSize: 1 }, async ([job]) => {
      if (job) this.logger.warn(`Authentication mail exhausted: ${job.id}`);
    });
  }
  async handle(job: Job<AuthMailJob>): Promise<JobResult> {
    try {
      if (!this.transport) throw new AuthMailError("unavailable");
      const payload = openAuthMail(job.data, env.APP_ENCRYPTION_KEY);
      const result = await this.transport.deliver(payload, async (current) => {
        if (current.kind === "verify")
          await verificationMailDeadline(
            current.link,
            env.BETTER_AUTH_SECRET ?? "",
            current.recipient,
          );
        return this.repository.ownership(current);
      });
      return {
        id: job.id,
        status: "completed",
        output: {
          status: result.status,
          ...(result.status === "skipped" ? { reason: result.reason } : {}),
        },
      };
    } catch (error) {
      const code = error instanceof AuthMailError ? error.code : "unavailable";
      if (code === "invalid_payload" || code === "unreadable_payload")
        return { id: job.id, status: "completed", output: { status: "skipped", reason: code } };
      return {
        id: job.id,
        status: code === "authentication" || code === "rejected" ? "deadletter" : "failed",
        output: { code },
      };
    }
  }
  onModuleDestroy() {
    this.transport?.close();
  }
}
