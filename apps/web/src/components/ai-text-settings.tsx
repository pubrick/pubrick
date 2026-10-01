"use client";
import {
  type AiCredentialPublic,
  type AiProviderId,
  type AiTextSettings,
  aiTextSettingsSchema,
  DEFAULT_TEXT_MODELS,
} from "@pubrick/shared";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { Advanced } from "@/components/ui/advanced";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage } from "@/lib/api";
export const AI_PROVIDER_NAMES: Record<AiProviderId, string> = {
  google: "Google",
  openrouter: "OpenRouter",
  openai: "OpenAI",
  anthropic: "Anthropic",
  deepseek: "DeepSeek",
  vertex: "Google Vertex AI",
  openai_compatible: "OpenAI-compatible API",
};

export function AiTextSettingsForm({
  credentials,
  onChanged,
  onDirtyChanged,
}: {
  credentials: AiCredentialPublic[] | null;
  onChanged: (settings: AiTextSettings) => void;
  onDirtyChanged?: (dirty: boolean) => void;
}) {
  const t = useTranslations("SettingsPage");
  const te = useTranslations("Errors");
  const [saved, setSaved] = useState<AiTextSettings | null>(null);
  const [provider, setProvider] = useState<AiProviderId | "">("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [justSaved, setJustSaved] = useState(false);
  const draftDirty = useRef(false);
  const forceReload = useRef(false);
  // Credential writes invalidate availability; workspace navigation remounts this form.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry invalidates a failed read.
  useEffect(() => {
    if (credentials === null) return;
    let live = true;
    setError(null);
    void api<unknown>("/api/ai-credentials/text-settings")
      .then((body) => {
        if (!live) return;
        const value = aiTextSettingsSchema.parse(body);
        setSaved(value);
        if (draftDirty.current && !forceReload.current) {
          onChanged(value);
          return;
        }
        forceReload.current = false;
        setProvider(value.provider ?? "");
        setModel(value.model ?? "");
        onChanged(value);
      })
      .catch((cause) => {
        if (live) setError(errorMessage(cause, t("genericError"), te));
      });
    return () => {
      live = false;
    };
  }, [credentials, onChanged, retry]);
  const dirty =
    saved !== null && (provider !== (saved.provider ?? "") || model.trim() !== (saved.model ?? ""));
  draftDirty.current = dirty;
  useEffect(() => {
    onDirtyChanged?.(dirty);
  }, [dirty, onDirtyChanged]);
  function reload() {
    forceReload.current = true;
    setJustSaved(false);
    setRetry((value) => value + 1);
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!saved || !provider || busy || !dirty) return;
    setBusy(true);
    setError(null);
    setJustSaved(false);
    try {
      const value = aiTextSettingsSchema.parse(
        await api<unknown>("/api/ai-credentials/text-settings", {
          method: "PUT",
          body: JSON.stringify({
            provider,
            model: model.trim() || null,
            expectedRevision: saved.revision,
          }),
        }),
      );
      setSaved(value);
      setProvider(value.provider ?? "");
      setModel(value.model ?? "");
      setJustSaved(true);
      onChanged(value);
    } catch (cause) {
      setError(errorMessage(cause, t("genericError"), te));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="mb-5 space-y-3 border-b border-border-soft pb-5"
      aria-label={t("aiTextTitle")}
    >
      <h3 className="font-semibold">{t("aiTextTitle")}</h3>
      <p className="text-sm text-fg-secondary">{t("aiTextHint")}</p>
      {saved === null ? (
        error ? (
          <Button variant="secondary" size="sm" onClick={reload}>
            {t("aiTextReload")}
          </Button>
        ) : (
          <Skeleton lines={2} />
        )
      ) : (
        <>
          <p
            role="status"
            className={saved.configured ? "text-sm text-fg-secondary" : "text-sm text-danger"}
          >
            {saved.provider
              ? saved.configured
                ? t("aiTextCurrent", {
                    provider: AI_PROVIDER_NAMES[saved.provider],
                    model: saved.modelId ?? "",
                  })
                : saved.modelId === null &&
                    credentials?.some((row) => row.provider === saved.provider)
                  ? t("aiTextModelRequired")
                  : t("aiTextMissing", { provider: AI_PROVIDER_NAMES[saved.provider] })
              : t("aiTextEmpty")}
          </p>
          <form onSubmit={save} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Select
                label={t("aiTextProvider")}
                value={provider}
                disabled={busy}
                onChange={(event) => {
                  setProvider(event.target.value as AiProviderId);
                  setModel("");
                  setJustSaved(false);
                }}
              >
                {!provider && <option value="">{t("aiTextSelect")}</option>}
                {saved.provider && !credentials?.some((row) => row.provider === saved.provider) && (
                  <option value={saved.provider}>{AI_PROVIDER_NAMES[saved.provider]}</option>
                )}
                {credentials?.map((row) => (
                  <option key={row.provider} value={row.provider}>
                    {AI_PROVIDER_NAMES[row.provider]}
                  </option>
                ))}
              </Select>
              {provider === "openai_compatible" ? (
                <Input
                  label={t("aiModelLabel")}
                  required
                  placeholder={t("aiModelPlaceholder")}
                  value={model}
                  disabled={busy}
                  maxLength={200}
                  onChange={(event) => {
                    setModel(event.target.value);
                    setJustSaved(false);
                  }}
                />
              ) : (
                <Advanced
                  label={t("aiTextModelOptions")}
                  dirty={Boolean(model.trim() || saved.model)}
                >
                  <Input
                    label={t("aiModelLabel")}
                    placeholder={
                      (provider ? DEFAULT_TEXT_MODELS[provider] : null) ?? t("aiModelPlaceholder")
                    }
                    value={model}
                    disabled={busy || !provider}
                    maxLength={200}
                    onChange={(event) => {
                      setModel(event.target.value);
                      setJustSaved(false);
                    }}
                  />
                </Advanced>
              )}
            </div>
            <p className="text-sm text-fg-secondary">{t("aiTextModelHint")}</p>
            {dirty && (
              <p role="status" className="text-sm text-warning">
                {t("aiTextUnsaved")}
              </p>
            )}
            {justSaved && !dirty && (
              <p role="status" className="text-sm text-fg-secondary">
                {t("aiTextSaved")}
              </p>
            )}
            <Button
              type="submit"
              size="sm"
              disabled={
                busy ||
                !dirty ||
                !provider ||
                (provider === "openai_compatible" && !model.trim()) ||
                !credentials?.some((row) => row.provider === provider)
              }
            >
              {t("aiTextSave")}
            </Button>
          </form>
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {error && saved !== null && (
        <Button variant="secondary" size="sm" onClick={reload}>
          {t("aiTextReload")}
        </Button>
      )}
    </section>
  );
}
