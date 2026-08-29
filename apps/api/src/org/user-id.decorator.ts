import {
  createParamDecorator,
  type ExecutionContext,
  InternalServerErrorException,
} from "@nestjs/common";
import type { auth } from "../auth";

// The shape the global AuthGuard (from @thallesp/nestjs-better-auth) assigns to
// request.session verbatim — it awaits auth.api.getSession() and stores the
// result. Same derivation as ActiveOrgGuard's, rather than a hand-written
// interface that could drift from better-auth's own type.
type AuthSession = Awaited<ReturnType<typeof auth.api.getSession>>;

/**
 * The signed-in user's id, from the session the global auth guard attaches.
 *
 * Throws loudly rather than handing the handler `undefined` cast to string, for
 * the same reason `OrgId` does: this value is written to `content_versions.
 * created_by`, so a missing one would silently store an anonymous row on a
 * route someone forgot to guard — and "who edited this" is the entire point of
 * the column.
 */
export const UserId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const session = ctx.switchToHttp().getRequest().session as AuthSession | undefined;
  const userId = session?.user.id;
  if (typeof userId !== "string" || userId.length === 0) {
    throw new InternalServerErrorException("UserId used on a route without the auth guard");
  }
  return userId;
});
