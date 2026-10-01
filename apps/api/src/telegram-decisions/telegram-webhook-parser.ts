import type { NestExpressApplication } from "@nestjs/platform-express";
import type { NextFunction, Request, Response } from "express";
import { TelegramBindingRepository } from "./telegram-binding.repository";

const route = /^\/api\/telegram\/webhook\/([A-Za-z0-9_-]{43})$/;
/** Install before init/listen and Better Auth's parser. Auth precedes bounded raw parsing. */
export function installTelegramWebhookParser(app: NestExpressApplication): void {
  app.use((request: Request, response: Response, next: NextFunction) => {
    const path = request.url.split("?")[0] ?? "";
    if (request.method !== "POST" || !path.startsWith("/api/telegram/webhook/")) return next();
    const match = route.exec(path);
    const secret = request.headers["x-telegram-bot-api-secret-token"];
    const copies = request.rawHeaders.filter(
      (_, index) =>
        index % 2 === 0 &&
        request.rawHeaders[index]?.toLowerCase() === "x-telegram-bot-api-secret-token",
    ).length;
    if (!match?.[1] || typeof secret !== "string" || copies !== 1) {
      response.status(401).json({ statusCode: 401, message: "Unauthorized" });
      return;
    }
    void app
      .get(TelegramBindingRepository)
      .authenticateRoute(match[1], secret)
      .then(() => next())
      .catch(() => {
        response.status(401).json({ statusCode: 401, message: "Unauthorized" });
      });
  });
  app.useBodyParser("raw", {
    type: (request) => request.method === "POST" && route.test(request.url?.split("?")[0] ?? ""),
    limit: 65536,
    inflate: false,
  });
}
