/** Better Auth stores role arrays as comma-separated names without trimming. */
export const ORGANIZATION_ROLES = ["owner", "admin", "member", "author", "editor"] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

/** Unknown names confer no permission; repeated names confer no extra permission. */
export function hasOrganizationRole(
  role: string | null | undefined,
  allowed: readonly OrganizationRole[],
): boolean {
  return role?.split(",").some((name) => allowed.some((candidate) => candidate === name)) ?? false;
}

export function isOrganizationManager(role: string | null | undefined): boolean {
  return hasOrganizationRole(role, ["owner", "admin"]);
}
