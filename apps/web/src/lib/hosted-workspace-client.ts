type WorkspaceRole = "admin" | "editor" | "author" | "member";

import { api } from "./api";

/** Mutations carry the selected workspace, never a guessed active tenant. */
const post = <T>(action: string, body: object) =>
  api<T>(`/api/hosted-admission/${action}`, { method: "POST", body: JSON.stringify(body) });
export const hostedWorkspace = {
  create: (body: { name: string; slug: string }) => post<{ id: string }>("create", body),
  invite: (body: {
    orgId: string;
    email: string;
    role: WorkspaceRole;
    locale: string;
    resendId?: string;
  }) => post<{ id: string; email: string; expiresAt: string }>("invite", body),
  accept: (body: { orgId: string; invitationId: string }) => post<unknown>("accept", body),
  cancel: (body: { orgId: string; invitationId: string }) => post<unknown>("cancel", body),
  updateRole: (body: { orgId: string; memberId: string; role: WorkspaceRole }) =>
    post<unknown>("update-role", body),
  remove: (body: { orgId: string; memberId: string }) => post<unknown>("remove", body),
  leave: (body: { orgId: string }) => post<unknown>("leave", body),
  delete: (body: { orgId: string }) => post<unknown>("delete", body),
};
