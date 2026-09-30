import {
  BadRequestException,
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { schema } from "@pubrick/db";
import type { ApiErrorCode } from "@pubrick/shared";
import { hasOrganizationRole, isOrganizationManager, ORGANIZATION_ROLES } from "@pubrick/shared";
import { fromNodeHeaders } from "better-auth/node";
import { and, eq } from "drizzle-orm";
import { forbidden, notFound } from "../api-error";
import { auth } from "../auth";
import { BrandAccessRepository } from "../brand-access/brand-access.repository";
import { db } from "../db";
import { type AuthorityRequest, REQUEST_AUTHORITY } from "../request-authority";
import { brandIdForResource } from "./brand-resource";
import {
  BRAND_SCOPE_KEY,
  type BrandResource,
  type BrandScopeMetadata,
} from "./brand-scope.decorator";
import {
  EDITORIAL_CAPABILITY_KEY,
  type EditorialCapability,
} from "./editorial-capability.decorator";

// Same shape auth.api.getSession() resolves to — the global AuthGuard (from
// @thallesp/nestjs-better-auth) awaits exactly that call and assigns the result to
// request.session verbatim (see its dist/index.mjs canActivate: `request.session = session`).
type AuthSession = Awaited<ReturnType<typeof auth.api.getSession>>;

type ScopedRequest = AuthorityRequest & {
  session?: AuthSession;
  headers: Record<string, string | string[] | undefined>;
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
  method?: string;
  orgId?: string;
  brandId?: string;
  visibleBrandIds?: string[] | null;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RESOURCE_NOT_FOUND_CODES: Partial<Record<BrandResource, ApiErrorCode>> = {
  brand: "brand_not_found",
  content: "content_not_found",
  run: "run_not_found",
  channel: "channel_not_found",
  media: "media_not_found",
  topic: "topic_not_found",
  knowledge: "knowledge_not_found",
  adaptation: "adaptation_not_found",
};

const RESOURCE_NOT_FOUND_MESSAGES: Partial<Record<BrandResource, string>> = {
  brand: "Brand not found",
  content: "Content not found",
  run: "Run not found",
  channel: "Channel not found",
  media: "Media not found",
  topic: "Topic not found",
  knowledge: "Knowledge entry not found",
  adaptation: "Adaptation not found",
};

function scopedId(request: ScopedRequest, source: "param" | "query" | "body", key: string): string {
  const value = request[source === "param" ? "params" : source]?.[key];
  // Guards run before ParseUUIDPipe and body validation. Reject arrays and other
  // malformed values here so a UUID column comparison cannot throw a database error.
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new BadRequestException(`Invalid ${key}`);
  }
  return value;
}

/** Requires an authenticated session with an active organization the user is a member of. */
@Injectable()
export class ActiveOrgGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly brandAccess: BrandAccessRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ScopedRequest>();
    // `request` is untyped (Nest's getRequest() has no generic here), so this cast is
    // explicit rather than an implicit `any`: the global AuthGuard runs before route guards
    // and already attached request.session as an AuthSession. Reuse it to avoid a second
    // getSession round-trip; re-fetch only if this guard somehow ran without that guard in
    // front of it (defense in depth, e.g. a future route that opts out of the global guard).
    const attachedSession = request.session as AuthSession | undefined;
    const session =
      attachedSession ?? (await auth.api.getSession({ headers: fromNodeHeaders(request.headers) }));
    if (!session) return false; // global auth guard normally rejects first; defense in depth
    const orgId = session.session.activeOrganizationId;
    if (!orgId) {
      // CODED, and the code is what the web actually acts on: it sends the
      // account to onboarding rather than showing it a screen it can never
      // load. That branch used to be decided by matching the sentence below
      // against /no active organization/i in the browser, which made a reword
      // — or a translation, which is where this product is going — a silent
      // change of behaviour. The sentence stays exactly as it was, for the
      // network tab and for a client older than the code.
      throw forbidden(
        "no_active_organization",
        "No active organization; create or select one first",
      );
    }
    const membership = await db
      .select({ id: schema.member.id, role: schema.member.role })
      .from(schema.member)
      .where(
        and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, session.user.id)),
      );
    if (membership.length === 0) {
      // Uncoded on purpose: the web replaces every non-org 403's sentence with
      // one of its own before a reader sees it, so this one is already
      // answered without a code. What it must NOT do is look like the refusal
      // above — the account has an organization, it just is not in this one,
      // and sending it to onboarding would be a loop.
      throw new ForbiddenException("Not a member of the active organization");
    }
    request.orgId = orgId;
    const scope = this.reflector.getAllAndOverride<BrandScopeMetadata>(BRAND_SCOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    // Every protected route must make an explicit access choice. This applies
    // to managers too, so a new route cannot accidentally inherit broad access.
    if (!scope) throw new ForbiddenException("Brand scope is required for this route");
    // Legacy duplicate rows represent one scoped account, not independent roles.
    const role = membership.map((row) => row.role).join(",");
    const approve = () => {
      request[REQUEST_AUTHORITY] = Object.freeze({
        kind: "session" as const,
        orgId,
        sessionId: session.session.id,
        userId: session.user.id,
        scope: Object.freeze({
          ...scope,
          ...(scope.kind === "org" && scope.editorialBrand
            ? { editorialBrand: Object.freeze({ ...scope.editorialBrand }) }
            : {}),
        }),
        capability: this.reflector.getAllAndOverride<EditorialCapability>(
          EDITORIAL_CAPABILITY_KEY,
          [context.getHandler()],
        ),
        mutation: !["GET", "HEAD"].includes(request.method ?? ""),
        brandId: request.brandId,
        resourceId:
          scope.kind === "resource"
            ? scopedId(request, scope.source ?? "param", scope.key ?? "id")
            : undefined,
      });
      return true;
    };
    const manager = isOrganizationManager(role);
    if (!hasOrganizationRole(role, ORGANIZATION_ROLES)) {
      throw new ForbiddenException("Organization role is not recognized");
    }
    const editorial =
      !manager &&
      !hasOrganizationRole(role, ["member"]) &&
      hasOrganizationRole(role, ["author", "editor"]);
    const checkEditorialMutation = () => {
      if (!editorial) return;
      if (request.method === "GET" || request.method === "HEAD") return;
      const capability = this.reflector.getAllAndOverride<EditorialCapability>(
        EDITORIAL_CAPABILITY_KEY,
        [context.getHandler()],
      );
      if (!capability || (capability === "editor" && !hasOrganizationRole(role, ["editor"]))) {
        throw new ForbiddenException("Editorial role cannot perform this action");
      }
    };
    if (scope.kind === "org-list") {
      request.visibleBrandIds = manager
        ? null
        : await this.brandAccess.visibleBrandIds(orgId, session.user.id);
      // A list has no single brand to authorize. Editorial mutations must use
      // a concrete brand or resource scope, even if someone adds metadata.
      if (editorial && !["GET", "HEAD"].includes(request.method ?? "")) {
        throw new ForbiddenException("Editorial role cannot perform this action");
      }
      return approve();
    }
    if (scope.kind === "org") {
      if (scope.roles === "manager" && !manager) {
        throw new ForbiddenException("Organization owner or admin required");
      }
      if (editorial && !["GET", "HEAD"].includes(request.method ?? "")) {
        // Only read-like POSTs with a declared brand can use this exception.
        // Other org-wide mutations have no grant to check and remain closed.
        if (!scope.editorialBrand) {
          throw new ForbiddenException("Editorial role cannot perform this action");
        }
        const brandId = scopedId(request, scope.editorialBrand.source, scope.editorialBrand.key);
        if (!(await this.brandAccess.hasAccess(orgId, brandId, session.user.id))) {
          throw notFound("brand_not_found", "Brand not found");
        }
        request.brandId = brandId;
        checkEditorialMutation();
      }
      return approve();
    }
    const brandId =
      scope.kind === "brand"
        ? scopedId(request, scope.source, scope.key ?? "brandId")
        : await brandIdForResource(
            orgId,
            scope.resource,
            scopedId(request, scope.source ?? "param", scope.key ?? "id"),
            db,
          );
    if (!brandId) {
      const code = scope.kind === "resource" ? RESOURCE_NOT_FOUND_CODES[scope.resource] : undefined;
      const message =
        scope.kind === "resource"
          ? (RESOURCE_NOT_FOUND_MESSAGES[scope.resource] ?? "Resource not found")
          : "Brand not found";
      throw code ? notFound(code, message) : new NotFoundException(message);
    }
    // Preserve the legacy member's manager-only 403 on an ungranted brand.
    // Dedicated editorial roles keep the hidden-resource 404 promise before
    // their capability is considered.
    if (scope.roles === "manager" && !manager && !editorial) {
      throw new ForbiddenException("Organization owner or admin required");
    }
    if (!(await this.brandAccess.hasAccess(orgId, brandId, session.user.id))) {
      const code = scope.kind === "resource" ? RESOURCE_NOT_FOUND_CODES[scope.resource] : undefined;
      const message =
        scope.kind === "resource"
          ? (RESOURCE_NOT_FOUND_MESSAGES[scope.resource] ?? "Resource not found")
          : "Brand not found";
      throw notFound(code ?? "brand_not_found", message);
    }
    request.brandId = brandId;
    if (scope.roles === "manager" && !manager) {
      throw new ForbiddenException("Organization owner or admin required");
    }
    checkEditorialMutation();
    return approve();
  }
}
