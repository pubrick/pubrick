import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { signedInSession } from "@/test/auth-client.stub";
import { render, screen, waitFor, within } from "@/test/render";
import en from "../../messages/en.json";
import es from "../../messages/es.json";
import { PaidReplyBrandSettings } from "./paid-reply-brand-settings";
import { PaidReplyOrganizationSettings } from "./paid-reply-organization-settings";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

const mockApi = vi.mocked(api);
const brand = {
  sourceEnabled: false,
  sourceRevision: 0,
  publicationEnabled: false,
  publicationRevision: 0,
  dailyThresholdUsd: 1,
  thresholdRevision: 0,
  admittedCostUsd: 0,
  blockedReason: null,
};
const org = {
  timezone: "UTC",
  dailyThresholdUsd: 5,
  revision: 0,
  admittedCostUsd: 0,
  blockedReason: null,
};

function membership(role: "owner" | "admin" | "member" | "author" | "editor") {
  signedInSession();
  vi.mocked(authClient.useActiveOrganization).mockReturnValue({
    data: {
      id: "org-1",
      name: "Workspace",
      members: [{ role, user: { id: "test-user" } }],
    },
    isPending: false,
  } as ReturnType<typeof authClient.useActiveOrganization>);
}

function installApi(withKey = true) {
  const calls: { path: string; method: string; body?: unknown }[] = [];
  mockApi.mockImplementation(async (path, init) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, method, body });
    if (path === "/api/paid-replies/organization") {
      return (method === "PUT" ? { ...org, ...body, revision: 1 } : org) as never;
    }
    if (path === "/api/ai-credentials/availability") {
      return { configured: withKey, googleConfigured: withKey } as never;
    }
    if (path.startsWith("/api/paid-replies/brands/")) {
      if (method === "GET") return brand as never;
      if (path.endsWith("/source")) return { ...brand, sourceEnabled: body.enabled } as never;
      if (path.endsWith("/publication"))
        return { ...brand, publicationEnabled: body.enabled } as never;
      if (path.endsWith("/threshold"))
        return { ...brand, dailyThresholdUsd: body.dailyThresholdUsd } as never;
    }
    throw new Error(`Unexpected API call: ${method} ${path}`);
  });
  return calls;
}

beforeEach(() => {
  mockApi.mockReset();
});

describe("paid reply brand settings", () => {
  it("keeps paid story consent off until confirmed and writes only its own consent", async () => {
    membership("owner");
    const calls = installApi();
    render(<PaidReplyBrandSettings brandId="brand-1" kind="source" />);
    const user = userEvent.setup();
    await screen.findByText(en.PaidReplies.off);
    expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
    await user.click(screen.getByRole("button", { name: en.PaidReplies.enable }));
    expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
    const dialog = within(screen.getByRole("dialog", { name: en.PaidReplies.confirmTitle }));
    expect(dialog.getByText(en.PaidReplies.confirmBody)).toBeInTheDocument();
    await user.click(dialog.getByRole("button", { name: en.PaidReplies.enable }));
    await waitFor(() =>
      expect(calls.filter((call) => call.method !== "GET")).toEqual([
        {
          path: "/api/paid-replies/brands/brand-1/source",
          method: "PUT",
          body: { enabled: true },
        },
      ]),
    );
    expect(await screen.findByText(en.PaidReplies.on)).toBeInTheDocument();
  });

  it("uses one brand threshold editor and a separate publication consent", async () => {
    membership("admin");
    const calls = installApi();
    const user = userEvent.setup();
    const { unmount } = render(<PaidReplyBrandSettings brandId="brand-1" kind="source" />);
    await screen.findByLabelText(en.PaidReplies.brandThresholdLabel);
    await user.clear(screen.getByLabelText(en.PaidReplies.brandThresholdLabel));
    await user.type(screen.getByLabelText(en.PaidReplies.brandThresholdLabel), "0.75");
    await user.click(screen.getByRole("button", { name: en.PaidReplies.save }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "/api/paid-replies/brands/brand-1/threshold",
        method: "PUT",
        body: { dailyThresholdUsd: 0.75 },
      }),
    );
    unmount();
    render(<PaidReplyBrandSettings brandId="brand-1" kind="publication" />);
    await screen.findByText(en.PaidReplies.publicationTitle);
    expect(screen.queryByLabelText(en.PaidReplies.brandThresholdLabel)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: en.PaidReplies.editOnSources })).toHaveAttribute(
      "href",
      "/en/brands/brand-1/sources#paid-reply-brand-threshold",
    );
    await user.click(screen.getByRole("button", { name: en.PaidReplies.enable }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: en.PaidReplies.enable }),
    );
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "/api/paid-replies/brands/brand-1/publication",
        method: "PUT",
        body: { enabled: true },
      }),
    );
  });

  it("shows missing-key guidance and keeps a regular member read-only in Spanish", async () => {
    membership("member");
    const calls = installApi(false);
    render(<PaidReplyBrandSettings brandId="brand-1" kind="source" />, { locale: "es" });
    expect(await screen.findByText(es.PaidReplies.off)).toBeInTheDocument();
    expect(await screen.findByText(es.PaidReplies.missingKey)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: es.PaidReplies.openSettings })).toHaveAttribute(
      "href",
      "/es/settings",
    );
    expect(screen.queryByRole("button", { name: es.PaidReplies.enable })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(es.PaidReplies.brandThresholdLabel)).not.toBeInTheDocument();
    expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
  });

  it("reads key availability without a privileged credential request for an author", async () => {
    membership("author");
    const calls = installApi();
    render(<PaidReplyBrandSettings brandId="brand-1" kind="source" />);
    expect(await screen.findByText(en.PaidReplies.off)).toBeInTheDocument();
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "/api/ai-credentials/availability",
        method: "GET",
        body: undefined,
      }),
    );
    expect(calls.some((call) => call.path === "/api/ai-credentials")).toBe(false);
    expect(screen.queryByRole("button", { name: en.PaidReplies.enable })).not.toBeInTheDocument();
  });
});

describe("paid reply organization settings", () => {
  it("validates IANA time zones and saves the organization admission threshold", async () => {
    const calls = installApi();
    const user = userEvent.setup();
    render(<PaidReplyOrganizationSettings canManage />);
    const zone = await screen.findByLabelText(en.PaidReplies.timezoneLabel);
    await user.clear(zone);
    await user.type(zone, "Not/A_Zone");
    await user.click(screen.getByRole("button", { name: en.PaidReplies.save }));
    expect(screen.getByRole("alert")).toHaveTextContent(en.PaidReplies.orgInvalid);
    expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
    await user.clear(zone);
    await user.type(zone, "Europe/Moscow");
    await user.clear(screen.getByLabelText(en.PaidReplies.orgThresholdLabel));
    await user.type(screen.getByLabelText(en.PaidReplies.orgThresholdLabel), "4.50");
    await user.click(screen.getByRole("button", { name: en.PaidReplies.save }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        path: "/api/paid-replies/organization",
        method: "PUT",
        body: { timezone: "Europe/Moscow", dailyThresholdUsd: 4.5 },
      }),
    );
  });

  it("shows organization settings to members without edit controls", async () => {
    const calls = installApi();
    render(<PaidReplyOrganizationSettings canManage={false} />);
    expect(
      await screen.findByText(
        en.PaidReplies.orgReadOnly.replace("{timezone}", "UTC").replace("{amount}", "$5.00"),
      ),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(en.PaidReplies.timezoneLabel)).not.toBeInTheDocument();
    expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
  });
});
