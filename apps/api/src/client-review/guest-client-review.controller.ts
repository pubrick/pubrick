import { createHash } from "node:crypto";
import { Body, Controller, Get, Header, HttpCode, Param, Post, Req, Res } from "@nestjs/common";
import { type ClientReviewVerdictInput, clientReviewVerdictSchema } from "@pubrick/shared";
import { AllowAnonymous } from "@thallesp/nestjs-better-auth";
import type { Request, Response } from "express";
import { LRUCache } from "lru-cache";
import { tooManyRequests } from "../api-error";
import { ZodValidationPipe } from "../validation.pipe";
import { ClientReviewRepository } from "./client-review.repository";

// The workspace already ships lru-cache. Its fixed TTL and bounded key space
// give these public capability routes a small per-process throttle without a
// second datastore. No plaintext token is kept as a cache key.
const guestReads = new LRUCache<string, { count: number }>({ max: 10_000, ttl: 60_000 });
const guestVerdicts = new LRUCache<string, { count: number }>({ max: 10_000, ttl: 60_000 });
const guestIps = new LRUCache<string, { count: number }>({ max: 10_000, ttl: 60_000 });

function consume(cache: LRUCache<string, { count: number }>, key: string, limit: number): void {
  const entry = cache.get(key);
  if (!entry) {
    cache.set(key, { count: 1 });
    return;
  }
  if (entry.count >= limit) {
    throw tooManyRequests("client_review_rate_limited", "Too many review requests");
  }
  // Mutate the cached counter: calling set() would reset its fixed window.
  entry.count += 1;
}

function limitGuest(token: string, request: Request, verdict = false): void {
  const hash = createHash("sha256").update(token).digest("hex");
  // socket.remoteAddress cannot be forged with X-Forwarded-For. Behind one
  // reverse proxy this generous ceiling is shared by its clients.
  consume(guestIps, request.socket.remoteAddress ?? "unknown", 600);
  consume(verdict ? guestVerdicts : guestReads, hash, verdict ? 8 : 60);
}

@Controller("client-review/:token")
@AllowAnonymous()
export class GuestClientReviewController {
  constructor(private readonly reviews: ClientReviewRepository) {}

  @Get()
  @Header("Cache-Control", "private, no-store")
  @Header("Referrer-Policy", "no-referrer")
  @Header("X-Robots-Tag", "noindex, nofollow")
  async guest(@Param("token") token: string, @Req() request: Request) {
    await limitGuest(token, request);
    return this.reviews.guest(token);
  }

  @Post("verdict")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  @Header("Referrer-Policy", "no-referrer")
  async verdict(
    @Param("token") token: string,
    @Req() request: Request,
    @Body(new ZodValidationPipe(clientReviewVerdictSchema)) body: ClientReviewVerdictInput,
  ) {
    await limitGuest(token, request, true);
    return this.reviews.verdict(token, body);
  }

  @Get("cover")
  async cover(@Param("token") token: string, @Req() request: Request, @Res() response: Response) {
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Robots-Tag", "noindex, nofollow");
    response.setHeader("X-Content-Type-Options", "nosniff");
    await limitGuest(token, request);
    const bytes = await this.reviews.cover(token);
    response.setHeader("Content-Type", "image/jpeg");
    response.setHeader("Content-Disposition", "inline");
    response.send(bytes);
  }

  @Get("video")
  async video(@Param("token") token: string, @Req() request: Request, @Res() response: Response) {
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Robots-Tag", "noindex, nofollow");
    response.setHeader("X-Content-Type-Options", "nosniff");
    await limitGuest(token, request);
    const filePath = await this.reviews.video(token);
    response.setHeader("Content-Type", "video/mp4");
    response.setHeader("Content-Disposition", "inline");
    await new Promise<void>((resolve) => {
      // Express handles byte ranges for video controls. Every range request revalidates
      // the capability before streaming; the path is derived from a scoped asset id.
      response.sendFile(filePath, (error) => {
        if (error && !response.headersSent) response.status(404).end();
        resolve();
      });
    });
  }
}
