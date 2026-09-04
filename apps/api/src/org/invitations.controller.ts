import { Controller, Get } from "@nestjs/common";
import { InvitationsRepository } from "./invitations.repository";
import { UserId } from "./user-id.decorator";

/**
 * What the onboarding screen asks when a brand-new account arrives with no
 * organization: "is anyone expecting you?"
 *
 * No `ActiveOrgGuard` here, deliberately — an invited account has no active
 * organization yet, which is the entire situation this answers. The global auth
 * guard still applies (nothing opts out with `@AllowAnonymous`), so a caller
 * without a session gets 401 and never reaches the repository; and the
 * repository is keyed on the session's own user id, so a caller can only ever
 * read the invitations addressed to themselves.
 */
@Controller("org")
export class InvitationsController {
  constructor(private readonly invitations: InvitationsRepository) {}

  @Get("invitations")
  list(@UserId() userId: string) {
    return this.invitations.listPendingForUser(userId);
  }
}
