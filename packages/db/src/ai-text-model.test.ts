import { describe, expect, it } from "vitest";
import {
  type AiSelectionState,
  aiTextSettingsView,
  snapshotAiTextSelection,
} from "./ai-text-selection.js";

function state(model: string | null): AiSelectionState {
  return {
    settings: { orgId: "fixture", provider: "openai_compatible", model, revision: 7 },
    credentials: [
      {
        id: "c2e74d47-45d6-46e4-b764-a5411c66fbb1",
        orgId: "fixture",
        provider: "openai_compatible",
        credentialsEncrypted: "opaque",
        defaultModel: null,
        revision: 2,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    ],
  };
}
describe("custom text-model admission", () => {
  it("does not present a saved key as usable or admit a guessed model", () => {
    expect(aiTextSettingsView(state(null))).toMatchObject({ configured: false, modelId: null });
    expect(() => snapshotAiTextSelection(state(null))).toThrow("Set a model ID");
  });
  it("pins the user's explicit model and credential revision together", () => {
    expect(aiTextSettingsView(state("my-text-model"))).toMatchObject({
      configured: true,
      modelId: "my-text-model",
    });
    expect(snapshotAiTextSelection(state("my-text-model"))).toMatchObject({
      provider: "openai_compatible",
      modelId: "my-text-model",
      credentialRevision: 2,
      settingsRevision: 7,
    });
  });
});
