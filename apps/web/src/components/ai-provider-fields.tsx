"use client";
import type { AiProviderId } from "@pubrick/shared";
import { useTranslations } from "next-intl";
import { Advanced } from "@/components/ui/advanced";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

export type AiProviderDraft = {
  authMode: "express" | "service_account";
  project: string;
  location: "global" | "us" | "eu";
  baseURL: string;
  proxyUrl: string;
  proxyEdited?: boolean;
};

/** Mode identity is visible; only optional proxy transport is disclosed progressively. */
export function AiProviderFields({
  provider,
  draft,
  disabled,
  proxyConfigured,
  onChange,
}: {
  provider: AiProviderId;
  draft: AiProviderDraft;
  disabled: boolean;
  proxyConfigured: boolean;
  onChange: (draft: AiProviderDraft) => void;
}) {
  const t = useTranslations("SettingsPage");
  if (provider === "openai_compatible")
    return (
      <>
        <Input
          label={t("aiCompatibleEndpoint")}
          type="url"
          value={draft.baseURL}
          required
          disabled={disabled}
          placeholder="https://api.example.com/v1"
          onChange={(event) => onChange({ ...draft, baseURL: event.target.value })}
        />
        <p className="text-sm text-fg-secondary">{t("aiCompatibleHint")}</p>
      </>
    );
  if (provider !== "vertex") return null;
  return (
    <>
      <Select
        label={t("aiVertexMode")}
        value={draft.authMode}
        disabled={disabled}
        onChange={(event) =>
          onChange({
            ...draft,
            authMode: event.target.value === "service_account" ? "service_account" : "express",
          })
        }
      >
        <option value="express">{t("aiVertexExpress")}</option>
        <option value="service_account">{t("aiVertexAccount")}</option>
      </Select>
      {draft.authMode === "service_account" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label={t("aiVertexProject")}
            value={draft.project}
            required
            disabled={disabled}
            onChange={(event) => onChange({ ...draft, project: event.target.value })}
          />
          <Select
            label={t("aiVertexLocation")}
            value={draft.location}
            disabled={disabled}
            onChange={(event) =>
              onChange({
                ...draft,
                location:
                  event.target.value === "us"
                    ? "us"
                    : event.target.value === "eu"
                      ? "eu"
                      : "global",
              })
            }
          >
            <option value="global">Global</option>
            <option value="us">US</option>
            <option value="eu">EU</option>
          </Select>
        </div>
      )}
      <p className="text-sm text-fg-secondary">
        {t(draft.authMode === "express" ? "aiVertexExpressHint" : "aiVertexAccountHint")}
      </p>
      <Advanced dirty={Boolean(draft.proxyEdited)}>
        <div className="space-y-2 p-4">
          <Input
            label={t("aiVertexProxy")}
            type="text"
            autoComplete="off"
            value={draft.proxyUrl}
            disabled={disabled}
            placeholder={t(proxyConfigured ? "aiVertexProxyReplace" : "aiProxyPlaceholder")}
            onChange={(event) =>
              onChange({ ...draft, proxyUrl: event.target.value, proxyEdited: true })
            }
          />
          <p className="text-sm text-fg-secondary">{t("aiVertexProxyHint")}</p>
        </div>
      </Advanced>
    </>
  );
}
