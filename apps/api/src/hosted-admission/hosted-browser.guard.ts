import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from "@nestjs/common";

export const HOSTED_BROWSER_ORIGIN = Symbol("HOSTED_BROWSER_ORIGIN");
/** Cookie-authenticated lifecycle writes retain Better Auth's trusted-origin boundary. */
@Injectable()
export class HostedBrowserGuard implements CanActivate {
  constructor(@Inject(HOSTED_BROWSER_ORIGIN) private readonly origin: string) {}
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ headers: Record<string, unknown> }>();
    const headers = request.headers;
    const contentType = headers["content-type"];
    if (
      headers.origin !== this.origin ||
      headers["sec-fetch-site"] === "cross-site" ||
      typeof contentType !== "string" ||
      contentType.split(";")[0]?.trim().toLowerCase() !== "application/json"
    )
      throw new ForbiddenException({
        code: "forbidden",
        message: "A trusted JSON request is required.",
      });
    return true;
  }
}
