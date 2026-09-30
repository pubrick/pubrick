import { beforeEach, expect, it, vi } from "vitest";
import { api } from "./api";
import { hostedWorkspace } from "./hosted-workspace-client";

vi.mock("./api", () => ({ api: vi.fn() }));
beforeEach(() => {
  vi.mocked(api).mockReset();
});
it("sends exact selected workspace and actor-free admission bodies", async () => {
  await hostedWorkspace.invite({
    orgId: "org-selected",
    email: "person@example.com",
    role: "author",
    locale: "ru",
  });
  expect(api).toHaveBeenCalledWith("/api/hosted-admission/invite", {
    method: "POST",
    body: JSON.stringify({
      orgId: "org-selected",
      email: "person@example.com",
      role: "author",
      locale: "ru",
    }),
  });
  await hostedWorkspace.accept({ orgId: "org-invitation", invitationId: "invite-1" });
  expect(api).toHaveBeenLastCalledWith("/api/hosted-admission/accept", {
    method: "POST",
    body: JSON.stringify({ orgId: "org-invitation", invitationId: "invite-1" }),
  });
});
