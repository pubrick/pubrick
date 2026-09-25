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
});
