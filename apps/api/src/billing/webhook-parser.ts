import type { NestExpressApplication } from "@nestjs/platform-express";

/** Install before init/listen: Better Auth's JSON middleware must not consume signed bytes. */
export function installBillingWebhookParser(app: NestExpressApplication): void {
  app.useBodyParser("raw", {
    type: (request) =>
      request.method === "POST" && request.url?.split("?")[0] === "/api/billing/webhook",
    limit: 1024 * 1024,
    inflate: false,
  });
}
