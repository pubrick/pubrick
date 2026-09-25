import { promptRevisionCreateSchema } from "@pubrick/shared";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signedInSession } from "@/test/auth-client.stub";
import { render, screen, waitFor } from "@/test/render";
import en from "../../../../../messages/en.json";
import PromptsPage from "./page";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

import { api } from "@/lib/api";

describe("generation guidance page", () => {
  beforeEach(() => {
    signedInSession();
    vi.mocked(api).mockReset();
  });

  it("compares pinned outcomes for one selected brand and refreshes on brand and role changes", async () => {
    const firstBrand = "e335cba1-c28a-42e2-a193-151d18218f85";
    const secondBrand = "7284f5b1-3077-4843-a057-dc3a998d5aea";
    const revisionId = "9e3abb7b-95b2-4d6f-b0df-e0801685d5ba";
    const calls: string[] = [];
    vi.mocked(api).mockImplementation(async (path) => {
      calls.push(path);
      if (path === "/api/brands")
        return [
          { id: firstBrand, name: "First brand" },
          { id: secondBrand, name: "Second brand" },
        ];
      if (path.endsWith("/outcomes?days=30"))
        return {
          brandId: path.includes(secondBrand) ? secondBrand : firstBrand,
          role: path.includes("/writer/") ? "writer" : "researcher",
          days: 30,
          rows: [
            {
              revisionId,
              version: 1,
              runCount: path.includes(secondBrand) ? 3 : 2,
              succeededRuns: 1,
              publishedRuns: 1,
              reviewActs: { approved: 1, rejected: 0 },
              currentItemStatuses: { published: 1 },
              withoutCurrentItem: 1,
            },
          ],
        };
      return [];
    });
    render(<PromptsPage />);
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.getByText(en.Prompts.outcomesCaveat)).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /Version 1.*2.*1.*1.*1/ })).toBeInTheDocument();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(en.Prompts.outcomesBrand), secondBrand);
    await waitFor(() =>
      expect(calls).toContain(`/api/prompts/brands/${secondBrand}/researcher/outcomes?days=30`),
    );
    expect(await screen.findByRole("row", { name: /Version 1.*3.*1.*1.*1/ })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(en.Prompts.role), "writer");
    await waitFor(() =>
      expect(calls).toContain(`/api/prompts/brands/${secondBrand}/writer/outcomes?days=30`),
    );
  });

  it("teaches the next action when no brand is available for outcome comparison", async () => {
    vi.mocked(api).mockResolvedValue([]);
    render(<PromptsPage />);
    expect(await screen.findByText(en.Prompts.outcomesNoBrands)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: en.Prompts.outcomesAddBrand })).toHaveAttribute(
      "href",
      "/en/brands",
    );
  });

  it("reloads the comparison after saving a new guidance revision", async () => {
    const brandId = "e335cba1-c28a-42e2-a193-151d18218f85";
    const outcomePath = `/api/prompts/brands/${brandId}/researcher/outcomes?days=30`;
    let outcomeRequests = 0;
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/brands") return [{ id: brandId, name: "Brand" }];
      if (path === outcomePath) {
        outcomeRequests += 1;
        return { brandId, role: "researcher", days: 30, rows: [] };
      }
      return [];
    });
    render(<PromptsPage />);
    await waitFor(() => expect(outcomeRequests).toBe(1));
    const save = screen.getByRole("button", { name: en.Prompts.save });
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.setup().click(save);
    await waitFor(() => expect(outcomeRequests).toBe(2));
  });

  it("saves the selected role's guidance with the API schema payload", async () => {
    const calls: { path: string; method: string; body: unknown }[] = [];
    vi.mocked(api).mockImplementation(async (path, init) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ path, method, body });
      return [];
    });
    render(<PromptsPage />);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(en.Prompts.role), "writer");
    const field = await screen.findByLabelText(en.Prompts.guidance);
    await user.type(field, "Write in a calm voice.");
    await user.click(screen.getByRole("button", { name: en.Prompts.save }));
    await waitFor(() =>
      expect(
        calls.some(
          (call) => call.path === "/api/prompts/writer/revisions" && call.method === "POST",
        ),
      ).toBe(true),
    );
    const saved = calls.find((call) => call.method === "POST");
    expect(saved?.body).toEqual({ guidance: "Write in a calm voice." });
    expect(promptRevisionCreateSchema.parse(saved?.body)).toEqual(saved?.body);
  });

  it("ignores a previous role's response after switching roles", async () => {
    const pending = new Map<string, (rows: unknown[]) => void>();
    vi.mocked(api).mockImplementation(
      (path) =>
        new Promise((resolve) => {
          pending.set(path, resolve);
        }),
    );
    render(<PromptsPage />);
    await waitFor(() => expect(pending.has("/api/prompts/researcher/revisions")).toBe(true));
    await userEvent.setup().selectOptions(screen.getByLabelText(en.Prompts.role), "writer");
    await waitFor(() => expect(pending.has("/api/prompts/writer/revisions")).toBe(true));
    pending.get("/api/prompts/writer/revisions")?.([
      {
        id: "9e3abb7b-95b2-4d6f-b0df-e0801685d5ba",
        role: "writer",
        version: 1,
        guidance: "Writer guidance",
        createdAt: "2026-09-23T00:00:00.000Z",
      },
    ]);
    expect(await screen.findByDisplayValue("Writer guidance")).toBeInTheDocument();
    pending.get("/api/prompts/researcher/revisions")?.([]);
    await waitFor(() => expect(screen.getByDisplayValue("Writer guidance")).toBeInTheDocument());
  });

  it("shows observed usage for the selected version and clears it when the role changes", async () => {
    const revision = {
      id: "9e3abb7b-95b2-4d6f-b0df-e0801685d5ba",
      role: "researcher",
      version: 1,
      guidance: "Find sources",
      createdAt: "2026-09-23T00:00:00.000Z",
    };
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === `/api/prompts/researcher/revisions/${revision.id}/usage?days=30`) {
        return {
          revisionId: revision.id,
          role: "researcher",
          days: 30,
          runCount: 2,
          runsByStatus: { queued: 0, running: 0, succeeded: 1, failed: 1, cancelled: 0 },
          currentItemStatuses: {
            draft: 0,
            approved: 1,
            partially_published: 0,
            rejected: 0,
            published: 0,
            failed: 0,
            archived: 0,
          },
          withoutCurrentItem: 1,
        };
      }
      if (path === "/api/prompts/researcher/revisions") return [revision];
      return [];
    });
    render(<PromptsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.Prompts.usage }));
    expect(await screen.findByText("Runs: 2")).toBeInTheDocument();
    expect(screen.getByText("No current linked draft: 1")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(en.Prompts.role), "writer");
    await waitFor(() => expect(screen.queryByText("Runs: 2")).not.toBeInTheDocument());
  });

  it("shows historical decisions separately and loads the next keyset page", async () => {
    const revision = {
      id: "9e3abb7b-95b2-4d6f-b0df-e0801685d5ba",
      role: "researcher",
      version: 1,
      guidance: "Find sources",
      createdAt: "2026-09-23T00:00:00.000Z",
    };
    const firstId = "4f84b4d0-c44e-4557-8451-482f3a7e946b";
    const secondId = "c904c7b9-0c7e-42cc-b7cc-cf9998f86c6e";
    vi.mocked(api).mockImplementation(async (path) => {
      if (path === "/api/prompts/researcher/revisions") return [revision];
      if (path === `/api/prompts/researcher/revisions/${revision.id}/decisions?days=30`) {
        return {
          revisionId: revision.id,
          role: "researcher",
          days: 30,
          counts: { approved: 1, rejected: 1 },
          rows: [
            {
              id: firstId,
              contentItemId: "fa0f14e8-cb2d-47ac-aa96-afcf4e2d8f7e",
              itemExists: true,
              verdict: "approved",
              decidedAt: "2026-09-24T12:00:00.000Z",
            },
          ],
          nextCursor: firstId,
        };
      }
      if (
        path ===
        `/api/prompts/researcher/revisions/${revision.id}/decisions?days=30&cursor=${firstId}`
      ) {
        return {
          revisionId: revision.id,
          role: "researcher",
          days: 30,
          counts: { approved: 1, rejected: 1 },
          rows: [
            {
              id: secondId,
              contentItemId: "bd14fddb-bd08-49d6-ae95-e1ef68b232de",
              itemExists: false,
              verdict: "rejected",
              decidedAt: "2026-09-23T12:00:00.000Z",
            },
          ],
          nextCursor: null,
        };
      }
      return [];
    });
    render(<PromptsPage />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: en.Prompts.decisions }));
    expect(await screen.findByText("Approved: 1 · Rejected: 1")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: en.Prompts.openDecisionDraft })).toHaveAttribute(
      "href",
      "/en/content/fa0f14e8-cb2d-47ac-aa96-afcf4e2d8f7e",
    );
    await user.click(screen.getByRole("button", { name: en.Prompts.loadMoreDecisions }));
    expect(await screen.findByText(en.Prompts.removedDecisionDraft)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: en.Prompts.loadMoreDecisions }),
    ).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(en.Prompts.role), "writer");
    await waitFor(() =>
      expect(screen.queryByText("Approved: 1 · Rejected: 1")).not.toBeInTheDocument(),
    );
  });
});
