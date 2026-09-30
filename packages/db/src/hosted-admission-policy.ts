import {
  hasOrganizationRole,
  isOrganizationManager,
  ORGANIZATION_ROLES,
  type OrganizationRole,
} from "@pubrick/shared";
export type HostedAdmissionCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "invalid_input"
  | "invalid_policy"
  | "owned_workspace_limit"
  | "creation_rate_limit"
  | "last_owner"
  | "invitation_unavailable"
  | "already_member";
export class HostedAdmissionError extends Error {
  constructor(readonly code: HostedAdmissionCode) {
    super(code);
    this.name = "HostedAdmissionError";
  }
}
export interface HostedCreationPolicy {
  maxOwnedWorkspaces: number;
  maxCreationsPerDay: number;
}
export const HOSTED_CREATION_WINDOW_MS = 24 * 60 * 60 * 1000;
export const HOSTED_INVITATION_LIFETIME_MS = 48 * 60 * 60 * 1000;
export function hasRole(role: string, expected: string): boolean {
  return hasOrganizationRole(role, [expected as OrganizationRole]);
}
export function isManager(role: string): boolean {
  return isOrganizationManager(role);
}
export function canonicalEmail(email: string): string {
  return email.toLowerCase();
}
/** Member user IDs and unmatched pending addresses reserve one seat each. */
export function admissionSeats(
  members: readonly { userId: string; email: string }[],
  pendingEmails: readonly string[],
): number {
  const userIds = new Set(members.map((m) => m.userId));
  const emails = new Set(members.map((m) => canonicalEmail(m.email)));
  return (
    userIds.size +
    new Set(pendingEmails.map(canonicalEmail).filter((email) => !emails.has(email))).size
  );
}
export function assertCreationPolicy(
  policy: HostedCreationPolicy,
  owned: number,
  recent: number,
): void {
  if (
    ![policy.maxOwnedWorkspaces, policy.maxCreationsPerDay].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    )
  )
    throw new HostedAdmissionError("invalid_policy");
  if (owned >= policy.maxOwnedWorkspaces) throw new HostedAdmissionError("owned_workspace_limit");
  if (recent >= policy.maxCreationsPerDay) throw new HostedAdmissionError("creation_rate_limit");
}
export function assertInvitationRole(actorRole: string, targetRole: string, resend: boolean): void {
  const normalized = normalizeHostedRoles(targetRole);
  if (hasRole(normalized, "owner") && !hasRole(actorRole, "owner"))
    throw new HostedAdmissionError("forbidden");
  if (isManager(actorRole)) return;
  if (hasRole(actorRole, "member") && normalized === "member" && !resend) return;
  throw new HostedAdmissionError("forbidden");
}
export function assertMemberRemoval(
  actorRole: string,
  targetRole: string,
  ownerCount: number,
): void {
  if (!isManager(actorRole) || (hasRole(targetRole, "owner") && !hasRole(actorRole, "owner")))
    throw new HostedAdmissionError("forbidden");
  if (hasRole(targetRole, "owner") && ownerCount <= 1) throw new HostedAdmissionError("last_owner");
}

export function normalizeHostedRoles(value: string | readonly string[]): string {
  const roles = [
    ...new Set(
      (typeof value === "string" ? [value] : value)
        .flatMap((role) => role.split(","))
        .map((role) => role.trim())
        .filter(Boolean),
    ),
  ];
  if (!roles.length || roles.some((role) => !ORGANIZATION_ROLES.some((known) => known === role)))
    throw new HostedAdmissionError("invalid_input");
  return roles.join(",");
}
export function assertRoleUpdate(
  actorRole: string,
  targetRole: string,
  nextRole: string,
  ownerCount: number,
): void {
  if (
    !isManager(actorRole) ||
    ((hasRole(targetRole, "owner") || hasRole(nextRole, "owner")) && !hasRole(actorRole, "owner"))
  )
    throw new HostedAdmissionError("forbidden");
  if (hasRole(targetRole, "owner") && !hasRole(nextRole, "owner") && ownerCount <= 1)
    throw new HostedAdmissionError("last_owner");
}
