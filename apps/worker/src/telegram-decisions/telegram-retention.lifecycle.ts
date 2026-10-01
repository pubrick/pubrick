import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { TelegramRetentionRepository } from "./telegram-retention.repository";

export const TELEGRAM_RETENTION_POLL_MS = 10_000;
@Injectable()
export class TelegramRetentionLifecycle implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramRetentionLifecycle.name);
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private closed = false;
  constructor(private readonly repository: TelegramRetentionRepository) {}
  onModuleInit(): void {
    if (this.closed || this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), TELEGRAM_RETENTION_POLL_MS);
    this.timer.unref();
  }
  private poll(): void {
    if (this.closed || this.active) return;
    this.active = this.tick()
      .catch(() => {
        this.logger.warn("Telegram retention scan failed: cleanup_unavailable");
      })
      .finally(() => {
        this.active = undefined;
      });
  }
  private async tick(): Promise<void> {
    const orgIds = await this.repository.candidates();
    let removed = 0;
    let failed = 0;
    for (const orgId of orgIds) {
      if (this.closed) break;
      try {
        removed += await this.repository.sweepOrg(orgId);
      } catch {
        failed++;
      }
    }
    if (failed) this.logger.warn(`Telegram retention batches failed: ${failed}`);
    if (removed) this.logger.log(`Telegram retention removed ephemeral rows: ${removed}`);
  }
  async onModuleDestroy(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.active;
  }
}
