import { SetMetadata } from "@nestjs/common";

export const NOT_ORG_SCOPED_KEY = "pubrick:not-org-scoped";

/**
 * Declares that every route on this controller is deliberately exempt from
 * `ActiveOrgGuard` — the organization concept does not apply to it (a pre-org
 * state, for instance) — and names why, at the controller itself rather than
 * in a hand-kept list somewhere else that a new controller cannot see.
 *
 * `tenancy-lists.e2e.spec.ts` ("every org-scoped controller route is
 * protected by the guard") requires every route to be covered by one of
 * three things: `ActiveOrgGuard` (class- or method-level `@UseGuards`),
 * `@AllowAnonymous` (no session at all, so no organization to be active in),
 * or this decorator. A controller with none of the three fails that gate —
 * new controller, decide, or the build breaks. The reason is required and
 * checked non-empty by both that static scan and this constructor, so a
 * `@NotOrgScoped("")` cannot slip past either.
 */
export const NotOrgScoped = (reason: string) => {
  if (reason.trim().length === 0) {
    throw new Error("NotOrgScoped requires a non-empty reason");
  }
  return SetMetadata(NOT_ORG_SCOPED_KEY, reason);
};
