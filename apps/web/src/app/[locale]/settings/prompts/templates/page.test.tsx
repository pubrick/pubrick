import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signedInSession } from "@/test/auth-client.stub";
import { render, screen, waitFor, within } from "@/test/render";
import en from "../../../../../../messages/en.json";
import RoleTemplatesPage from "./page";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

import { api } from "@/lib/api";

const revisionId = "67b7855a-80e7-4d56-8ad9-831f3c14a9f0";
const brandId = "369b0832-baa8-4e6d-974d-e9edb79e1db8";
const otherBrandId = "606838b6-d805-4d4e-8f51-85dbd0e863ca";
const head = {
  role: "researcher",
  activeRevisionId: null,
  activeVersion: null,
  generation: 0,
  builtInSource: "Plan a clear angle.",
};

describe("role template editor", () => {
  beforeEach(() => {
    signedInSession();
    vi.mocked(api).mockReset();
  });

  it("previews and saves an inactive draft, then activates only after confirmation", async () => {
    const calls: Array<{ path: string; method: string; body: unknown }> = [];
    vi.mocked(api).mockImplementation(async (path, init) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ path, method, body });
      if (path === "/api/brands") return [];
      if (path === "/api/prompts/templates") return [head];
      if (path.endsWith("/templates/revisions") && method === "GET")
        return { rows: [], nextCursor: null };
      if (path.endsWith("/templates/preview"))
        return {
          source: body.source,
          renderedBody: body.source,
          variables: [],
          renderedBodyBytes: 20,
          sampleInstructionBytes: 1024,
        };
      if (path.endsWith("/templates/revisions") && method === "POST")
        return {
          id: revisionId,
          role: "researcher",
          version: 1,
          source: body.source,
          sourceSha256: "a".repeat(64),
          createdAt: "2026-09-25T00:00:00.000Z",
        };
      if (path.endsWith("/templates/active"))
        return { ...head, activeRevisionId: revisionId, activeVersion: 1, generation: 1 };
      throw new Error(`Unexpected API call ${path}`);
    });
    render(<RoleTemplatesPage />);
    const user = userEvent.setup();
    const source = await screen.findByLabelText(en.RoleTemplates.source);
    expect(source).toHaveValue("Plan a clear angle.");
    await user.clear(source);
    await user.type(source, "Plan a useful angle.");
    await user.click(screen.getByRole("button", { name: en.RoleTemplates.preview }));
    expect(
      await screen.findByText("Plan a useful angle.", { selector: "pre" }),
    ).toBeInTheDocument();
    expect(
      calls.filter((call) => call.method === "POST" && call.path.endsWith("/preview")),
    ).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: en.RoleTemplates.saveDraft }));
    expect(await screen.findByText("Version 1 saved as an inactive draft.")).toBeInTheDocument();
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(0);
    await user.click(screen.getByText(en.RoleTemplates.history));
    await user.click(screen.getByRole("button", { name: en.RoleTemplates.activate }));
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(0);
    await user.click(
      within(screen.getByRole("dialog", { name: en.RoleTemplates.activateTitle })).getByRole(
        "button",
        { name: en.RoleTemplates.confirmActivate },
      ),
    );
    await waitFor(() => expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1));
    expect(calls.find((call) => call.method === "PUT")?.body).toEqual({
      revisionId,
      expectedRevisionId: null,
      expectedGeneration: 0,
    });
  });

  it("warns before changing roles with unsaved instructions", async () => {
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/brands") return [];
      if (path === "/api/prompts/templates") return [head, { ...head, role: "writer" }];
      return { rows: [], nextCursor: null };
    });
    render(<RoleTemplatesPage />);
    const user = userEvent.setup();
    const source = await screen.findByLabelText(en.RoleTemplates.source);
    await user.type(source, " Extra");
    await user.selectOptions(screen.getByLabelText(en.RoleTemplates.role), "writer");
    expect(screen.getByRole("dialog", { name: en.RoleTemplates.discardTitle })).toBeInTheDocument();
    expect(screen.getByLabelText(en.RoleTemplates.role)).toHaveValue("researcher");
    await user.click(screen.getByRole("button", { name: en.RoleTemplates.cancel }));
    expect(source).toHaveValue("Plan a clear angle. Extra");
  });

  it("shows default and revision cohorts, then loads the next page for the selected brand and window", async () => {
    const calls: string[] = [];
    const defaultRow = {
      kind: "default",
      revisionId: null,
      version: null,
      runCount: 3,
      succeededRuns: 2,
      publishedRuns: 1,
      currentItemStatuses: { draft: 1 },
      withoutCurrentItem: 1,
      reviewActs: { approved: 2, rejected: 1 },
    };
    const revisionRow = {
      ...defaultRow,
      kind: "revision",
      revisionId,
      version: 2,
      runCount: 7,
    };
    vi.mocked(api).mockImplementation(async (path) => {
      calls.push(path);
      if (path === "/api/brands")
        return [
          { id: brandId, name: "Example Brand" },
          { id: otherBrandId, name: "Other Brand" },
        ];
      if (path === "/api/prompts/templates")
        return [{ ...head, activeRevisionId: revisionId, activeVersion: 2 }];
      if (path === "/api/prompts/researcher/templates/revisions")
        return {
          rows: [{ id: revisionId, version: 2, source: "Current source" }],
          nextCursor: null,
        };
      if (path.endsWith("/templates/outcomes?days=30"))
        return {
          brandId,
          role: "researcher",
          days: 30,
          activeRevisionId: revisionId,
          default: defaultRow,
          rows: [revisionRow],
          nextCursor: 2,
        };
      if (path.endsWith("/templates/outcomes?days=30&cursor=2"))
        return {
          brandId,
          role: "researcher",
          days: 30,
          activeRevisionId: revisionId,
          default: defaultRow,
          rows: [
            { ...revisionRow, revisionId: "e7b2554c-7225-43de-a428-6f7dc5cb361c", version: 1 },
          ],
          nextCursor: null,
        };
      if (path === `/api/prompts/brands/${brandId}/researcher/templates/outcomes?days=7`)
        return {
          brandId,
          role: "researcher",
          days: 7,
          activeRevisionId: revisionId,
          default: { ...defaultRow, runCount: 0 },
          rows: [],
          nextCursor: null,
        };
      if (path === `/api/prompts/brands/${otherBrandId}/researcher/templates/outcomes?days=7`)
        return {
          brandId: otherBrandId,
          role: "researcher",
          days: 7,
          activeRevisionId: revisionId,
          default: { ...defaultRow, runCount: 5 },
          rows: [],
          nextCursor: null,
        };
      throw new Error(`Unexpected API call ${path}`);
    });
    render(<RoleTemplatesPage />);
    const user = userEvent.setup();
    await screen.findByLabelText(en.RoleTemplates.source);
    await user.click(screen.getByText(en.RoleTemplates.outcomesTitle));
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /Built-in.*3.*2.*1/ })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /Version 2.*7/ })).toHaveTextContent("Active now");
    await user.click(screen.getByRole("button", { name: en.RoleTemplates.loadMore }));
    expect(await screen.findByRole("row", { name: /Version 1.*7/ })).toBeInTheDocument();
    expect(calls).toContain(
      `/api/prompts/brands/${brandId}/researcher/templates/outcomes?days=30&cursor=2`,
    );
    await user.selectOptions(screen.getByLabelText(en.RoleTemplates.outcomesWindow), "7");
    await waitFor(() =>
      expect(calls).toContain(
        `/api/prompts/brands/${brandId}/researcher/templates/outcomes?days=7`,
      ),
    );
    expect(screen.queryByRole("row", { name: /Version 1.*7/ })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(en.RoleTemplates.outcomesBrand), otherBrandId);
    expect(await screen.findByRole("row", { name: /Built-in.*5/ })).toBeInTheDocument();
  });
});
