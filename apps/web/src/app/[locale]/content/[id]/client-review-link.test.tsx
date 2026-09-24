import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/test/render";
import { ClientReviewLink } from "./client-review-link";

const { mockApi, mockApiVoid, mockSession, mockOrganization } = vi.hoisted(() => ({
  mockApi: vi.fn(),
  mockApiVoid: vi.fn(),
  mockSession: vi.fn(),
  mockOrganization: vi.fn(),
}));

vi.mock("@/lib/api", async (original) => {
  const actual = await original<typeof import("@/lib/api")>();
  return { ...actual, api: mockApi, apiVoid: mockApiVoid };
});
vi.mock("@/lib/auth-client", () => ({
  authClient: { useSession: mockSession, useActiveOrganization: mockOrganization },
}));

const none = { status: "none", expiresAt: null, reviewedAt: null, comment: null };

beforeEach(() => {
  mockApi.mockReset();
  mockApiVoid.mockReset();
  mockSession.mockReturnValue({ data: { user: { id: "u1" } } });
  mockOrganization.mockReturnValue({
    data: { members: [{ userId: "u1", role: "owner" }] },
  });
  mockApi.mockResolvedValue(none);
});

describe("client review link control", () => {
  it("shows a capability only once to an owner and removes it on revoke", async () => {
    mockApi.mockImplementation(async (_path: string, init?: RequestInit) =>
      init?.method === "POST"
        ? { status: "pending", token: "secret-capability", expiresAt: "2026-09-25T12:00:00Z" }
        : none,
    );
    mockApiVoid.mockResolvedValue(undefined);
    render(<ClientReviewLink itemId="c1" revision="v1" canCreate />);
    await screen.findByText("No client review requested");
    await userEvent.setup().click(screen.getByRole("button", { name: "Create review link" }));
    expect(screen.getByTestId("client-review-link")).toHaveTextContent(
      "/en/review/secret-capability",
    );
    expect(mockApi).toHaveBeenCalledWith("/api/content/c1/client-review-link", {
      method: "POST",
      body: "{}",
    });
    await userEvent.setup().click(screen.getByRole("button", { name: "Revoke link" }));
    await waitFor(() => expect(screen.queryByTestId("client-review-link")).not.toBeInTheDocument());
    expect(mockApiVoid).toHaveBeenCalledWith("/api/content/c1/client-review-link", {
      method: "DELETE",
    });
  });

  it("shows the decision to a member but no link management controls", async () => {
    mockOrganization.mockReturnValue({
      data: { members: [{ userId: "u1", role: "member" }] },
    });
    mockApi.mockResolvedValue({
      status: "changes_requested",
      expiresAt: "2026-09-25T12:00:00Z",
      reviewedAt: "2026-09-23T12:00:00Z",
      comment: "Correct the date",
    });
    render(<ClientReviewLink itemId="c1" revision="v1" canCreate />);
    expect(await screen.findByText("Client requested changes")).toBeInTheDocument();
    expect(screen.getByText("Correct the date")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create a new link" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Revoke link" })).not.toBeInTheDocument();
    mockApi.mockResolvedValue({
      status: "approved",
      expiresAt: "2026-09-25T12:00:00Z",
      reviewedAt: "2026-09-23T12:01:00Z",
      comment: null,
    });
    await userEvent.setup().click(screen.getByRole("button", { name: "Refresh client response" }));
    expect(await screen.findByText("Client approved this exact draft")).toBeInTheDocument();
  });

  it("does not offer a new link for a post already leaving the queue", async () => {
    render(<ClientReviewLink itemId="c1" revision="v1" canCreate={false} />);
    expect(await screen.findByText("No client review requested")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create review link" })).not.toBeInTheDocument();
  });
});
