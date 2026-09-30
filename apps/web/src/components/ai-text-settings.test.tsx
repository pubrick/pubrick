import type { AiCredentialPublic, AiTextSettings } from "@pubrick/shared";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/test/render";
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
