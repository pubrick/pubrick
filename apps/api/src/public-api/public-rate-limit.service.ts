import { createHash } from "node:crypto";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import {
  HttpException,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import pg from "pg";
import { RateLimiterPostgres, RateLimiterRes } from "rate-limiter-flexible";
import { env } from "../env";
import { type AuthorityRequest, REQUEST_AUTHORITY } from "../request-authority";
@Injectable()
export class PublicRateLimitService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PublicRateLimitService.name);
  private readonly pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: 2,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 10000,
    options: "-c statement_timeout=2000 -c lock_timeout=1000",
  });
  private readonly limiters = new Map<string, RateLimiterPostgres>();
  private closed = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private cleanup: Promise<void> | undefined;
  constructor() {
    this.pool.on("error", () => this.logger.warn("public_request_limiter_connection_error"));
  }
  onModuleInit() {
    this.timer = setInterval(() => void this.cleanExpired(), 60000);
    this.timer.unref();
  }
  private limiter(kind: "write" | "poll", subject: "key" | "org") {
    const prefix = `v2:${kind}:${subject}`;
    let limiter = this.limiters.get(prefix);
    if (!limiter) {
      limiter = new RateLimiterPostgres({
        storeClient: this.pool,
        storeType: "pool",
        schemaName: "public",
        tableName: "api_request_limits",
        tableCreated: true,
        clearExpiredByTimeout: false,
        keyPrefix: prefix,
        points: kind === "write" ? (subject === "key" ? 30 : 60) : subject === "key" ? 60 : 120,
        duration: 60,
        inMemoryBlockOnConsumed: 0,
        execEvenly: false,
      });
      this.limiters.set(prefix, limiter);
    }
    return limiter;
  }
  async consume(orgId: string, keyId: string, kind: "write" | "poll"): Promise<void> {
    if (this.closed)
      throw new HttpException(
        { code: "public_request_unavailable", message: "Request admission is unavailable" },
        503,
      );
    try {
      await this.limiter(kind, "key").consume(
        createHash("sha256").update(`${orgId}:${keyId}`).digest("hex"),
      );
      await this.limiter(kind, "org").consume(createHash("sha256").update(orgId).digest("hex"));
    } catch (error) {
      if (error instanceof RateLimiterRes)
        throw new HttpException(
          {
            code: "public_rate_limited",
            message: "Request limit reached",
            retryAfterSeconds: Math.min(60, Math.max(1, Math.ceil(error.msBeforeNext / 1000))),
          },
          429,
        );
      this.logger.warn("public_request_limiter_unavailable");
      throw new HttpException(
        { code: "public_request_unavailable", message: "Request admission is unavailable" },
        503,
      );
    }
  }
  /** Only bounded transient buckets; immutable operation records are never pruned. */
  async cleanExpired(): Promise<void> {
    if (this.closed || this.cleanup) return;
    this.cleanup = (async () => {
      try {
        await this.pool.query(
          `WITH expired AS (SELECT key FROM public.api_request_limits WHERE expire < floor(extract(epoch from clock_timestamp())*1000)::bigint - 3600000 ORDER BY expire,key LIMIT 1000 FOR UPDATE SKIP LOCKED) DELETE FROM public.api_request_limits AS bucket USING expired WHERE bucket.key=expired.key`,
        );
      } catch {
        this.logger.warn("public_request_limiter_cleanup_failed");
      }
    })();
    try {
      await this.cleanup;
    } finally {
      this.cleanup = undefined;
    }
  }
  async onModuleDestroy() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.cleanup;
    await this.pool.end();
  }
}
@Injectable()
export class PublicRateLimitGuard implements CanActivate {
  constructor(private readonly limiter: PublicRateLimitService) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthorityRequest & { method: string }>();
    const actor = req[REQUEST_AUTHORITY];
    if (actor?.kind !== "api-key")
      throw new HttpException(
        { code: "public_authority_revoked", message: "API key authority required" },
        403,
      );
    try {
      await this.limiter.consume(actor.orgId, actor.keyId, req.method === "GET" ? "poll" : "write");
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === 429) {
        const body = error.getResponse();
        if (typeof body === "object" && "retryAfterSeconds" in body)
          context
            .switchToHttp()
            .getResponse<{ setHeader: (key: string, value: string) => void }>()
            .setHeader("Retry-After", String(body.retryAfterSeconds));
      }
      throw error;
    }
    return true;
  }
}
