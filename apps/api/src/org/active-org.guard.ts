import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { schema } from "@pubrick/db";
import { fromNodeHeaders } from "better-auth/node";
import { and, eq } from "drizzle-orm";
import { forbidden } from "../api-error";
import { auth } from "../auth";
import { db } from "../db";

// Same shape auth.api.getSession() resolves to — the global AuthGuard (from
// @thallesp/nestjs-better-auth) awaits exactly that call and assigns the result to
// request.session verbatim (see its dist/index.mjs canActivate: `request.session = session`).
type AuthSession = Awaited<ReturnType<typeof auth.api.getSession>>;

/** Requires an authenticated session with an active organization the user is a member of. */
@Injectable()
export class ActiveOrgGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
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
      .select({ id: schema.member.id })
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
    return true;
  }
}
