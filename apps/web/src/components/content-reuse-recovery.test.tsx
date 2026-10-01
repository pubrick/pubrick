import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPendingContentReuse,
  retainPendingContentReuse,
  settlePendingContentReuse,
} from "@/lib/pending-content-reuse";
import { authClient, signedInOrganization, signedInSession } from "@/test/auth-client.stub";
import { routerMock } from "@/test/next-navigation.stub";
import { act, render, screen, waitFor } from "@/test/render";
import en from "../../messages/en.json";
import { ContentReuseRecoveryBoundary } from "./content-reuse-recovery";

const TARGET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RESULT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const identity = { userId: "test-user", orgId: "test-org" };
const body = {
  expectedSourceRevision: 3,
  expectedSourceDigest: "a".repeat(64),
  contentType: "social_post" as const,
  channelIds: [RESULT],
  allowPaidGeneration: true as const,
  consentVersion: "byok-paid-generation-v1" as const,
};
const originalSession = authClient.useSession.getMockImplementation();
const originalOrganization = authClient.useActiveOrganization.getMockImplementation();
function overrideSession(state: ReturnType<typeof authClient.useSession>) {
  vi.spyOn(authClient, "useSession").mockImplementation(() => {
    originalSession?.();
    return state;
  });
}
const read = vi.fn();
function Resource() {
  useEffect(() => {
    read();
  }, []);
  return <div>Resource read</div>;
}
function boundary(targetId = TARGET, operation: "reuse" | "reuse-retry" = "reuse") {
  return (
    <ContentReuseRecoveryBoundary targetId={targetId} operation={operation}>
      <Resource />
    </ContentReuseRecoveryBoundary>
  );
}
let key: string;
beforeEach(() => {
  if (originalSession) authClient.useSession.mockImplementation(originalSession);
  if (originalOrganization)
    authClient.useActiveOrganization.mockImplementation(originalOrganization);
  signedInSession();
  signedInOrganization();
  key = crypto.randomUUID();
  read.mockReset();
  retainPendingContentReuse(identity, { operation: "reuse", targetId: TARGET, key, body });
});
afterEach(() => {
  settlePendingContentReuse(identity, "reuse", TARGET, key);
  vi.unstubAllGlobals();
});

describe("pending paid operation recovery", () => {
  it("bypasses a deleted resource read and posts only the original confirmed DTO/key", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: RESULT, status: "queued" }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetch);
    render(boundary());
    expect(read).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: en.Reuse.retry }));
    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith(`/en/content/runs/${RESULT}`));
    expect(fetch.mock.calls[0]?.[0]).toContain(`/api/content/${TARGET}/reuse`);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify(body),
      headers: expect.objectContaining({ "Idempotency-Key": key }),
    });
    expect(getPendingContentReuse(identity, "reuse", TARGET)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
  it("real API 401 triggers the shell redirect; login remount retains the original recovery operation", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: RESULT, status: "queued" }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetch);
    const first = render(boundary());
    await userEvent.click(screen.getByRole("button", { name: en.Reuse.retry }));
    await waitFor(() => expect(routerMock.replace).toHaveBeenCalled());
    expect(getPendingContentReuse(identity, "reuse", TARGET)?.key).toBe(key);
    first.unmount();
    signedInSession();
    signedInOrganization();
    render(boundary());
    await userEvent.click(screen.getByRole("button", { name: en.Reuse.retry }));
    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith(`/en/content/runs/${RESULT}`));
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(fetch.mock.calls[0]?.[1]?.body);
    expect(fetch.mock.calls[1]?.[1]?.headers).toEqual(fetch.mock.calls[0]?.[1]?.headers);
    expect(read).not.toHaveBeenCalled();
  });
  it("switches identities while mounted without exposing or posting another context's pending operation", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const mounted = render(boundary());
    expect(read).not.toHaveBeenCalled();
    overrideSession({
      data: { user: { id: "other", email: "other@example.com" } },
      isPending: false,
      refetch: async () => {},
    });
    mounted.rerender(boundary());
    expect(screen.getByText("Resource read")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: en.Reuse.retry })).not.toBeInTheDocument();
    overrideSession({
      data: { user: { id: identity.userId, email: "test@example.com" } },
      isPending: false,
      refetch: async () => {},
    });
    vi.spyOn(authClient, "useActiveOrganization").mockReturnValue({
      data: { id: "other-org", name: "Other" },
      isPending: false,
    });
    mounted.rerender(boundary());
    expect(screen.queryByRole("button", { name: en.Reuse.retry })).not.toBeInTheDocument();
    vi.spyOn(authClient, "useActiveOrganization").mockReturnValue({
      data: { id: identity.orgId, name: "Original" },
      isPending: false,
    });
    mounted.rerender(boundary());
    expect(screen.getByRole("button", { name: en.Reuse.retry })).toBeInTheDocument();
    mounted.rerender(boundary(RESULT));
    expect(screen.queryByRole("button", { name: en.Reuse.retry })).not.toBeInTheDocument();
    mounted.rerender(boundary(TARGET, "reuse-retry"));
    expect(screen.queryByRole("button", { name: en.Reuse.retry })).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("resolved signed-out sessions reach login without resource reads", async () => {
    overrideSession({
      data: null,
      isPending: false,
      refetch: async () => {},
    });
    render(boundary());
    await waitFor(() =>
      expect(routerMock.replace).toHaveBeenCalledWith(expect.stringContaining("/en/login")),
    );
    expect(read).not.toHaveBeenCalled();
  });
  it("resolved missing organizations reach onboarding without resource reads", async () => {
    vi.spyOn(authClient, "useActiveOrganization").mockReturnValue({ data: null, isPending: false });
    render(boundary());
    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith("/en/onboarding"));
    expect(read).not.toHaveBeenCalled();
  });
  it("retained identity data during context loading cannot restore another context", async () => {
    vi.spyOn(authClient, "useActiveOrganization").mockReturnValue({
      data: { id: identity.orgId, name: "Previous" },
      isPending: true,
    });
    render(boundary());
    await act(async () => {});
    expect(read).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: en.Reuse.retry })).not.toBeInTheDocument();
  });
  it("waits for resolved identity before mounting resource readers", async () => {
    overrideSession({
      data: null,
      isPending: true,
      refetch: async () => {},
    });
    render(boundary());
    await act(async () => {});
    expect(read).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: en.Reuse.retry })).not.toBeInTheDocument();
  });
});
