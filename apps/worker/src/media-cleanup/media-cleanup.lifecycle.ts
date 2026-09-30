import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { MediaCleanupService } from "./media-cleanup.service";

/** Bounded durable cleanup runs independently of the publication queue. */
@Injectable()
export class MediaCleanupLifecycle implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MediaCleanupLifecycle.name);
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private closed = false;
  constructor(private readonly service: MediaCleanupService) {}
  onModuleInit(): void {
    if (this.closed || this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), 10000);
    this.timer.unref();
  }
  private poll(): void {
    if (this.closed || this.active) return;
    this.active = this.service
      .tick()
      .catch(() => {
        this.logger.warn("Media cleanup poll failed: cleanup_unavailable");
      })
      .finally(() => {
        this.active = undefined;
      });
  }
  async onModuleDestroy(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.active;
  }
}
