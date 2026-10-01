import type { NestExpressApplication } from "@nestjs/platform-express";
/** Before Better Auth middleware: scoped pre-parse size admission never changes webhook bytes. */
export function installPublicWriteParser(app: NestExpressApplication): void {
  app.useBodyParser("json", {
    type: (request) =>
      request.method === "POST" &&
      /^\/api\/v2\/(?:content|runs)\/?$/.test((request.url?.split("?")[0] ?? "").toLowerCase()),
    limit: 1024 * 1024,
    inflate: false,
    strict: true,
  });
}
