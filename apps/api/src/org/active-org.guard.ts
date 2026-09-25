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
import { fromNodeHeaders } from "better-auth/node";
import { and, eq, sql } from "drizzle-orm";
import { forbidden, notFound } from "../api-error";
import { auth } from "../auth";
import { BrandAccessRepository } from "../brand-access/brand-access.repository";
import { db } from "../db";
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

type ScopedRequest = {
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

/** Only fixed schema tables may be interpolated into resource lookups. */
const RESOURCE_TABLES = {
  topic: schema.topics,
  content: schema.contentItems,
  run: schema.pipelineRuns,
  channel: schema.channels,
  calendarSlot: schema.calendarSlots,
  newsItem: schema.newsItems,
  media: schema.mediaAssets,
  knowledge: schema.knowledgeEntries,
  source: schema.newsSources,
  sourceItem: schema.newsItems,
  memorableDate: schema.memorableDates,
  generationJob: schema.pipelineRuns,
} as const;

function scopedId(request: ScopedRequest, source: "param" | "query" | "body", key: string): string {
  const value = request[source === "param" ? "params" : source]?.[key];
  // Guards run before ParseUUIDPipe and body validation. Reject arrays and other
  // malformed values here so a UUID column comparison cannot throw a database error.
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new BadRequestException(`Invalid ${key}`);
  }
  return value;
}

async function brandIdForResource(
  orgId: string,
  resource: BrandResource,
  id: string,
): Promise<string | null> {
  if (resource === "brand") {
    const [brand] = await db
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, id)))
      .limit(1);
    return brand?.id ?? null;
  }
  if (resource === "publication") {
    // Historical receipts may outlive their adaptation and channel. An orphan
    // has no surviving brand relationship, so it is deliberately inaccessible
    // through brand-scoped routes.
    const [row] = await db
      .select({ brandId: schema.contentItems.brandId })
      .from(schema.publications)
      .innerJoin(schema.adaptations, eq(schema.publications.adaptationId, schema.adaptations.id))
      .innerJoin(schema.contentItems, eq(schema.adaptations.contentItemId, schema.contentItems.id))
      .where(and(eq(schema.publications.orgId, orgId), eq(schema.publications.id, id)))
      .limit(1);
    return row?.brandId ?? null;
  }
  if (resource === "adaptation") {
    const [row] = await db
      .select({ brandId: schema.contentItems.brandId })
      .from(schema.adaptations)
      .innerJoin(schema.contentItems, eq(schema.adaptations.contentItemId, schema.contentItems.id))
      .where(and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.id, id)))
      .limit(1);
    return row?.brandId ?? null;
  }
  const table = RESOURCE_TABLES[resource];
  const result = await db.execute<{ brand_id: string }>(
    sql`select brand_id from ${table} where org_id = ${orgId} and id = ${id} limit 1`,
  );
  return result.rows[0]?.brand_id ?? null;
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
      )
      .limit(1);
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
    const manager = membership[0]?.role === "owner" || membership[0]?.role === "admin";
    const role = membership[0]?.role;
    const checkEditorialMutation = () => {
      if (role !== "author" && role !== "editor") return;
      if (request.method === "GET" || request.method === "HEAD") return;
      const capability = this.reflector.getAllAndOverride<EditorialCapability>(
        EDITORIAL_CAPABILITY_KEY,
        [context.getHandler()],
      );
      if (!capability || (capability === "editor" && role !== "editor")) {
        throw new ForbiddenException("Editorial role cannot perform this action");
      }
    };
    if (scope.kind === "org-list") {
      request.visibleBrandIds = manager
        ? null
        : await this.brandAccess.visibleBrandIds(orgId, session.user.id);
      // A list has no single brand to authorize. Editorial mutations must use
      // a concrete brand or resource scope, even if someone adds metadata.
      if (
        (role === "author" || role === "editor") &&
        !["GET", "HEAD"].includes(request.method ?? "")
      ) {
        throw new ForbiddenException("Editorial role cannot perform this action");
      }
      return true;
    }
    if (scope.kind === "org") {
      if (scope.roles === "manager" && !manager) {
        throw new ForbiddenException("Organization owner or admin required");
      }
      if (
        (role === "author" || role === "editor") &&
        !["GET", "HEAD"].includes(request.method ?? "")
      ) {
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
      return true;
    }
    const brandId =
      scope.kind === "brand"
        ? scopedId(request, scope.source, scope.key ?? "brandId")
        : await brandIdForResource(
            orgId,
            scope.resource,
            scopedId(request, scope.source ?? "param", scope.key ?? "id"),
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
    if (scope.roles === "manager" && !manager && role !== "author" && role !== "editor") {
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
    return true;
  }
}
