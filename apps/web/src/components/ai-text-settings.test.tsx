import {
  type AiCredentialPublic,
  type AiTextSettings,
  aiTextSettingsUpdateSchema,
} from "@pubrick/shared";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@/test/render";
import en from "../../messages/en.json";
import { AiTextSettingsForm } from "./ai-text-settings";

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: vi.fn(),
}));

import { ApiError, api } from "@/lib/api";

const mockApi = vi.mocked(api);
const credentials: AiCredentialPublic[] = (["google", "openai"] as const).map((provider) => ({
  provider,
  defaultModel: null,
  proxyConfigured: false,
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
}));
const initial: AiTextSettings = {
  provider: "google",
  model: null,
  modelId: "gemini-3.8-flash",
  revision: 4,
  configured: true,
};
beforeEach(() => vi.clearAllMocks());
function install(value = initial, refusal = false) {
  mockApi.mockImplementation(async (_path, init) => {
    if (!init?.method) return value;
    if (refusal) throw new ApiError(409, "stale", false, "ai_settings_changed");
    const body = JSON.parse(String(init.body));
    return {
      provider: body.provider,
      model: body.model,
      modelId: body.model ?? "gpt-6-luna",
      revision: 5,
      configured: true,
    };
  });
}
describe("workspace text settings", () => {
  it("shows the required custom model immediately and reports pending changes to navigation", async () => {
    install({
      provider: "openai_compatible",
      model: null,
      modelId: null,
      revision: 4,
      configured: false,
    });
    const dirty = vi.fn();
    render(
      <AiTextSettingsForm
        credentials={[
          {
            provider: "openai_compatible",
            defaultModel: null,
            proxyConfigured: false,
            updatedAt: "2026-09-01T00:00:00Z",
          },
        ]}
        onChanged={vi.fn()}
        onDirtyChanged={dirty}
      />,
    );
    await screen.findByText(en.SettingsPage.aiTextModelRequired);
    expect(screen.getByLabelText(en.SettingsPage.aiModelLabel)).toBeVisible();
    expect(screen.getByRole("button", { name: en.SettingsPage.aiTextSave })).toBeDisabled();
    await userEvent
      .setup()
      .type(screen.getByLabelText(en.SettingsPage.aiModelLabel), "my-server-model");
    expect(dirty).toHaveBeenLastCalledWith(true);
    await userEvent.setup().click(screen.getByRole("button", { name: en.SettingsPage.aiTextSave }));
    await screen.findByText(en.SettingsPage.aiTextSaved);
    expect(dirty).toHaveBeenLastCalledWith(false);
  });
  it("saves provider and model together with a revision, independently of credentials", async () => {
    install();
    const changed = vi.fn();
    render(<AiTextSettingsForm credentials={credentials} onChanged={changed} />);
    await screen.findByText(
      en.SettingsPage.aiTextCurrent
        .replace("{provider}", "Google")
        .replace("{model}", "gemini-3.8-flash"),
    );
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(en.SettingsPage.aiTextProvider), "openai");
    await user.click(screen.getByText(en.SettingsPage.aiTextModelOptions));
    await user.type(screen.getByLabelText(en.SettingsPage.aiModelLabel), "custom-text-model");
    expect(screen.getByText(en.SettingsPage.aiTextUnsaved)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: en.SettingsPage.aiTextSave }));
    await screen.findByText(en.SettingsPage.aiTextSaved);
    expect(mockApi).toHaveBeenLastCalledWith("/api/ai-credentials/text-settings", {
      method: "PUT",
      body: JSON.stringify({ provider: "openai", model: "custom-text-model", expectedRevision: 4 }),
    });
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider: "openai", modelId: "custom-text-model", revision: 5 }),
    );
    expect(screen.queryByRole("button", { name: en.SettingsPage.test })).toBeNull();
  });
  it("preserves unsaved text choices when credential availability refreshes", async () => {
    install();
    const changed = vi.fn();
    const view = render(<AiTextSettingsForm credentials={credentials} onChanged={changed} />);
    await screen.findByLabelText(en.SettingsPage.aiTextProvider);
    await userEvent
      .setup()
      .selectOptions(screen.getByLabelText(en.SettingsPage.aiTextProvider), "openai");
    view.rerender(<AiTextSettingsForm credentials={[...credentials]} onChanged={changed} />);
    await waitFor(() => expect(mockApi).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText(en.SettingsPage.aiTextProvider)).toHaveValue("openai");
    expect(screen.getByText(en.SettingsPage.aiTextUnsaved)).toBeInTheDocument();
  });

  it("uses the refreshed first-key revision without discarding an in-progress model choice", async () => {
    let stored: AiTextSettings = {
      provider: null,
      model: null,
      modelId: null,
      revision: 0,
      configured: false,
    };
    let resolveRefresh!: (value: AiTextSettings) => void;
    const refresh = new Promise<AiTextSettings>((resolve) => {
      resolveRefresh = resolve;
    });
    let reads = 0;
    mockApi.mockImplementation(async (_path, init) => {
      if (!init?.method) return ++reads === 1 ? stored : refresh;
      const body = aiTextSettingsUpdateSchema.parse(JSON.parse(String(init.body)));
      if (body.expectedRevision !== stored.revision) {
        throw new ApiError(
          409,
          "AI settings changed. Reload and try again.",
          false,
          "ai_settings_changed",
        );
      }
      stored = {
        provider: body.provider,
        model: body.model,
        modelId: body.model,
        revision: stored.revision + 1,
        configured: true,
      };
      return stored;
    });
    const changed = vi.fn();
    const view = render(<AiTextSettingsForm credentials={[]} onChanged={changed} />);
    await screen.findByLabelText(en.SettingsPage.aiTextProvider);
    stored = { ...initial, revision: 1 };
    view.rerender(
      <AiTextSettingsForm
        credentials={credentials.filter((row) => row.provider === "google")}
        onChanged={changed}
      />,
    );
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(en.SettingsPage.aiTextProvider), "google");
    await user.click(screen.getByText(en.SettingsPage.aiTextModelOptions));
    await user.type(screen.getByLabelText(en.SettingsPage.aiModelLabel), "gemini-3.8-flash");
    await act(async () => resolveRefresh(stored));
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 1 }));
    expect(screen.getByLabelText(en.SettingsPage.aiTextProvider)).toHaveValue("google");
    expect(screen.getByLabelText(en.SettingsPage.aiModelLabel)).toHaveValue("gemini-3.8-flash");
    expect(screen.getByText(en.SettingsPage.aiTextUnsaved)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: en.SettingsPage.aiTextSave }));
    await screen.findByText(en.SettingsPage.aiTextSaved);
    const request = mockApi.mock.calls.find(([, init]) => init?.method === "PUT")?.[1];
    const literal = { provider: "google", model: "gemini-3.8-flash", expectedRevision: 1 };
    expect(JSON.parse(String(request?.body))).toEqual(literal);
    expect(aiTextSettingsUpdateSchema.parse(JSON.parse(String(request?.body)))).toEqual(literal);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ revision: 2 }));
  });

  it("retains a missing default rather than visually switching to another saved key", async () => {
    install({ ...initial, configured: false });
    render(
      <AiTextSettingsForm
        credentials={credentials.filter((row) => row.provider === "openai")}
        onChanged={vi.fn()}
      />,
    );
    await screen.findByText(en.SettingsPage.aiTextMissing.replace("{provider}", "Google"));
    expect(screen.getByLabelText(en.SettingsPage.aiTextProvider)).toHaveValue("google");
    expect(screen.getByRole("button", { name: en.SettingsPage.aiTextSave })).toBeDisabled();
    await userEvent
      .setup()
      .selectOptions(screen.getByLabelText(en.SettingsPage.aiTextProvider), "openai");
    expect(screen.getByRole("button", { name: en.SettingsPage.aiTextSave })).toBeEnabled();
  });
  it("does not report stale writes as saved", async () => {
    install(initial, true);
    render(<AiTextSettingsForm credentials={credentials} onChanged={vi.fn()} />);
    await screen.findByLabelText(en.SettingsPage.aiTextProvider);
    await userEvent
      .setup()
      .selectOptions(screen.getByLabelText(en.SettingsPage.aiTextProvider), "openai");
    await userEvent.setup().click(screen.getByRole("button", { name: en.SettingsPage.aiTextSave }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(en.Errors.ai_settings_changed),
    );
    expect(screen.queryByText(en.SettingsPage.aiTextSaved)).toBeNull();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: en.SettingsPage.aiTextReload }));
    await waitFor(() =>
      expect(screen.getByLabelText(en.SettingsPage.aiTextProvider)).toHaveValue("google"),
    );
    expect(screen.queryByText(en.SettingsPage.aiTextUnsaved)).toBeNull();
  });
});
