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
});
