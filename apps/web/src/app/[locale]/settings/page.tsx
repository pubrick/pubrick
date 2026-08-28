"use client";

import {
  AI_PROVIDERS,
  type AiCredentialPublic,
  type AiCredentialTestResult,
  type AiProviderId,
  type AiTestFailure,
  type CostSummary,
  formatUsd,
} from "@pubrick/shared";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Advanced } from "@/components/ui/advanced";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { ListRow } from "@/components/ui/list-row";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { ApiError, api, errorMessage } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { applyTheme, readThemePref, type ThemePref } from "@/lib/theme";

/**
 * A message key for every failure the API can report.
 *
 * A total `Record` rather than a lookup with a fallback: a new code added to
 * `AI_TEST_FAILURES` is a compile error here, instead of rendering its raw key
 * path to a user in four languages. The API sends codes precisely so that a
 * provider's own 401 body — which quotes the submitted key — never reaches a
 * browser, and so that this sentence can be translated at all.
 */
const TEST_FAILURE_KEYS: Record<AiTestFailure, string> = {
  invalid_key: "aiTestFailInvalidKey",
  model_not_found: "aiTestFailModelNotFound",
  no_structured_output: "aiTestFailNoStructuredOutput",
  rate_limited: "aiTestFailRateLimited",
  refused: "aiTestFailRefused",
  unreadable_key: "aiTestFailUnreadableKey",
};

/** Vendor names. Wire ids are never shown raw, and brand names are not translated. */
const PROVIDER_NAMES: Record<AiProviderId, string> = {
  google: "Google",
  openrouter: "OpenRouter",
};

// The key form's id. The constitution puts the one primary action top-right in
// the toolbar, never a save button at the foot of a form, so the submit button
// lives in AppShell's header and is wired back here via `form={AI_FORM_ID}`.
const AI_FORM_ID = "ai-credential-form";

export default function SettingsPage() {
  const t = useTranslations("SettingsPage");
  const tLanding = useTranslations("Landing");
  const { data: session } = authClient.useSession();
  const { data: organization } = authClient.useActiveOrganization();

  const [pref, setPref] = useState<ThemePref>("system");
  // Stored pref is client-only state: reading it during the first render makes
  // the SSR html (always "system") disagree with the client and React reports
  // a hydration mismatch — so sync it after mount instead.
  useEffect(() => {
    setPref(readThemePref());
  }, []);

  const [credentials, setCredentials] = useState<AiCredentialPublic[]>([]);
  const [spend, setSpend] = useState<CostSummary | null>(null);
  const [provider, setProvider] = useState<AiProviderId>("google");
  const [apiKey, setApiKey] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [aiError, setAiError] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<
    Partial<Record<AiProviderId, AiCredentialTestResult | "loading">>
  >({});

  // An account with no organization yet is an onboarding state, not an error to
  // shout about on the Settings screen — every other failure gets a sentence.
  const handleAiError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.noActiveOrg) return;
      setAiError(errorMessage(err, t("genericError")));
    },
    [t],
  );

  const loadAi = useCallback(() => {
    api<AiCredentialPublic[]>("/api/ai-credentials").then(setCredentials).catch(handleAiError);
    api<CostSummary>("/api/ai-credentials/spend")
      .then(setSpend)
      .catch(() => {});
  }, [handleAiError]);

  useEffect(loadAi, [loadAi]);

  function changeTheme(value: string) {
    const next = value as ThemePref;
    applyTheme(next);
    setPref(next);
  }

  async function saveKey(e: React.FormEvent) {
    e.preventDefault();
    setAiError(null);
    // The field is omitted rather than sent empty: null in that column means
    // "use the provider's own default model", and "" is not a model id.
    const trimmedModel = defaultModel.trim();
    const body = {
      provider,
      apiKey,
      ...(trimmedModel === "" ? {} : { defaultModel: trimmedModel }),
    };
    try {
      await api("/api/ai-credentials", { method: "PUT", body: JSON.stringify(body) });
      setApiKey("");
      setDefaultModel("");
      // A new key makes every earlier verdict meaningless. Same reason the
      // server never caches a test: a green tick must always describe the key
      // that is stored right now.
      setTestResults({});
      loadAi();
    } catch (err) {
      handleAiError(err);
    }
  }

  async function testKey(id: AiProviderId) {
    setTestResults((prev) => ({ ...prev, [id]: "loading" }));
    try {
      const result = await api<AiCredentialTestResult>(`/api/ai-credentials/${id}/test`, {
        method: "POST",
      });
      setTestResults((prev) => ({ ...prev, [id]: result }));
      // The test was a real, billed call — the org's spend just moved.
      loadAi();
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [id]: { ok: false, reason: errorMessage(err, t("genericError")) },
      }));
    }
  }

  async function removeKey(id: AiProviderId) {
    setAiError(null);
    try {
      await api(`/api/ai-credentials/${id}`, { method: "DELETE" });
      setTestResults((prev) => ({ ...prev, [id]: undefined }));
      loadAi();
    } catch (err) {
      handleAiError(err);
    }
  }

  /**
   * The three display rules of the design's §4, rendered.
   *
   * The fourth branch is the one that matters most: a summary that is a floor of
   * exactly zero means every call we know about went unpriced, and "≥ $0.00"
   * would read as "this was free". It says so in words instead.
   */
  function costText(summary: CostSummary): string {
    if (summary.kind === "exact") return formatUsd(summary.usd);
    if (summary.kind === "approximate")
      return t("aiCostApprox", { amount: formatUsd(summary.usd) });
    if (summary.usd === 0) return t("aiCostUnknown", { count: summary.unpricedCalls });
    return t("aiCostAtLeast", {
      amount: formatUsd(summary.usd),
      count: summary.unpricedCalls,
    });
  }

  function testMeta(id: AiProviderId) {
    const result = testResults[id];
    if (result === undefined) return undefined;
    if (result === "loading") return "…";
    if (!result.ok) {
      return (
        <span role="alert" className="text-danger">
          {t(TEST_FAILURE_KEYS[result.reason])}
        </span>
      );
    }
    return t("aiTestOk", { model: result.modelId, cost: costText(result.cost) });
  }

  const themeOptions = [
    { value: "system", label: t("themeSystem") },
    { value: "light", label: t("themeLight") },
    { value: "dark", label: t("themeDark") },
  ];

  return (
    <AppShell
      title={t("title")}
      primaryAction={
        <Button type="submit" form={AI_FORM_ID}>
          {t("aiSave")}
        </Button>
      }
    >
      <div className="flex max-w-xl flex-col gap-4">
        <Card>
          <h2 className="mb-3 text-base font-semibold text-fg">{t("appearanceTitle")}</h2>
          <Segmented options={themeOptions} value={pref} onChange={changeTheme} />
        </Card>

        <Card>
          <h2 className="mb-1 text-base font-semibold text-fg">{t("aiTitle")}</h2>
          <p className="mb-3 text-sm text-fg-secondary">
            {t("aiSpend", { amount: spend === null ? "—" : costText(spend) })}
          </p>

          {aiError && (
            <p role="alert" className="mb-3 text-sm text-danger">
              {aiError}
            </p>
          )}

          {credentials.length === 0 ? (
            <EmptyState title={t("aiEmpty")} className="py-6" />
          ) : (
            <div className="mb-4 overflow-hidden rounded-card border border-border">
              {credentials.map((credential) => (
                <ListRow
                  key={credential.provider}
                  title={PROVIDER_NAMES[credential.provider] ?? credential.provider}
                  meta={
                    testMeta(credential.provider) ??
                    (credential.defaultModel || t("aiProviderDefault"))
                  }
                  trailing={
                    <>
                      <Button
                        size="sm"
                        variant="secondary"
                        // Every click is a real, billed call — two physical ones
                        // when the repair retry fires — so an impatient
                        // double-click must not be charged twice.
                        disabled={testResults[credential.provider] === "loading"}
                        onClick={() => testKey(credential.provider)}
                      >
                        {t("test")}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => removeKey(credential.provider)}
                      >
                        {t("remove")}
                      </Button>
                    </>
                  }
                />
              ))}
            </div>
          )}

          <form id={AI_FORM_ID} onSubmit={saveKey} className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-3">
              <Select
                label={t("aiProviderLabel")}
                value={provider}
                onChange={(e) => setProvider(e.target.value as AiProviderId)}
                className="min-w-[160px]"
              >
                {AI_PROVIDERS.map((id) => (
                  <option key={id} value={id}>
                    {PROVIDER_NAMES[id]}
                  </option>
                ))}
              </Select>
              <Input
                type="password"
                autoComplete="off"
                label={t("aiKeyLabel")}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                required
                className="min-w-[200px] flex-1"
              />
            </div>
            {/* Constitution rule 2: the one option most people never set lives
                behind the shared disclosure, never loose on the form. */}
            <Advanced dirty={defaultModel.trim() !== ""}>
              <Input
                label={t("aiModelLabel")}
                placeholder={t("aiModelPlaceholder")}
                value={defaultModel}
                onChange={(e) => setDefaultModel(e.target.value)}
                className="w-full"
              />
            </Advanced>
          </form>
        </Card>

        <Card>
          <h2 className="mb-3 text-base font-semibold text-fg">{t("accountTitle")}</h2>
          <p className="mb-3 text-sm text-fg-secondary">{session?.user?.email}</p>
          <Button variant="secondary" onClick={() => authClient.signOut()}>
            {tLanding("signOut")}
          </Button>
        </Card>

        <Card>
          <h2 className="mb-3 text-base font-semibold text-fg">{t("workspaceTitle")}</h2>
          <p className="text-sm text-fg-secondary">{organization?.name ?? t("workspaceNoOrg")}</p>
        </Card>
      </div>
    </AppShell>
  );
}
