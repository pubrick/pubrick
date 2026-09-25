"use client";

import {
  type AiCredentialPublic,
  type BrandPaidReplySettingsDto,
  formatUsd,
  type OrganizationPaidReplySettingsDto,
  type PAID_REPLY_BLOCK_REASONS,
} from "@pubrick/shared";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Input } from "./ui/input";
import { Modal } from "./ui/modal";

type Kind = "source" | "publication";
type Reason = (typeof PAID_REPLY_BLOCK_REASONS)[number];

const REASON_KEYS: Record<Reason, string> = {
  hourly_limit: "blockHourly",
  brand_daily_threshold: "blockBrandThreshold",
  org_daily_threshold: "blockOrgThreshold",
  unknown_spend: "blockUnknownSpend",
  unpriced_model: "blockUnpricedModel",
  no_key: "blockNoKey",
  request_too_large: "blockRequestTooLarge",
  setting_changed: "blockSettingChanged",
  sample_changed: "blockSampleChanged",
  target_unavailable: "blockTargetUnavailable",
  day_changed: "blockDayChanged",
  price_changed: "blockPriceChanged",
};

export function PaidReplyBrandSettings({ brandId, kind }: { brandId: string; kind: Kind }) {
  const t = useTranslations("PaidReplies");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const { data: session } = authClient.useSession();
  const { data: organization } = authClient.useActiveOrganization();
  const canManage = organization?.members?.some(
    (member) =>
      member.user.id === session?.user?.id && (member.role === "owner" || member.role === "admin"),
  );
  const [settings, setSettings] = useState<BrandPaidReplySettingsDto | null>(null);
  const [orgSettings, setOrgSettings] = useState<OrganizationPaidReplySettingsDto | null>(null);
  const [hasGoogleKey, setHasGoogleKey] = useState<boolean | null>(null);
  const [amount, setAmount] = useState("1.00");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const value = await api<BrandPaidReplySettingsDto>(`/api/paid-replies/brands/${brandId}`);
      setSettings(value);
      setAmount(value.dailyThresholdUsd.toFixed(2));
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause, t("loadError"), te));
    }
  }, [brandId, t, te]);

  useEffect(() => {
    let active = true;
    void api<BrandPaidReplySettingsDto>(`/api/paid-replies/brands/${brandId}`)
      .then((value) => {
        if (!active) return;
        setSettings(value);
        setAmount(value.dailyThresholdUsd.toFixed(2));
      })
      .catch((cause: unknown) => {
        if (active) setError(errorMessage(cause, t("loadError"), te));
      });
    void api<OrganizationPaidReplySettingsDto>("/api/paid-replies/organization")
      .then((value) => {
        if (active) setOrgSettings(value);
      })
      .catch(() => {});
    void api<AiCredentialPublic[]>("/api/ai-credentials")
      .then((keys) => {
        if (active) setHasGoogleKey(keys.some((key) => key.provider === "google"));
      })
      .catch(() => {
        if (active) setHasGoogleKey(null);
      });
    return () => {
      active = false;
    };
  }, [brandId, t, te]);

  async function saveConsent(enabled: boolean) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await api<BrandPaidReplySettingsDto>(
        `/api/paid-replies/brands/${brandId}/${kind}`,
        { method: "PUT", body: JSON.stringify({ enabled }) },
      );
      setSettings(next);
      setNotice(t(enabled ? "enabled" : "disabled"));
      setConfirm(false);
    } catch (cause) {
      setError(errorMessage(cause, t("saveError"), te));
    } finally {
      setBusy(false);
    }
  }

  async function saveThreshold() {
    const value = Number(amount);
    if (!/^\d+(?:\.\d{1,2})?$/.test(amount) || value < 0.01 || value > 5) {
      setError(t("thresholdInvalid"));
      return;
    }
    if (orgSettings && value > orgSettings.dailyThresholdUsd) {
      setError(t("thresholdAboveOrg", { amount: formatUsd(orgSettings.dailyThresholdUsd) }));
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await api<BrandPaidReplySettingsDto>(
        `/api/paid-replies/brands/${brandId}/threshold`,
        { method: "PUT", body: JSON.stringify({ dailyThresholdUsd: value }) },
      );
      setSettings(next);
      setAmount(next.dailyThresholdUsd.toFixed(2));
      setNotice(t("thresholdSaved"));
    } catch (cause) {
      setError(errorMessage(cause, t("saveError"), te));
    } finally {
      setBusy(false);
    }
  }

  if (!settings && !error) return null;
  const enabled = kind === "source" ? settings?.sourceEnabled : settings?.publicationEnabled;
  return (
    <>
      <Card className={kind === "source" ? "mb-8" : undefined}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-prose">
            <h2 className="text-lg font-semibold text-fg">
              {t(kind === "source" ? "sourceTitle" : "publicationTitle")}
            </h2>
            <p className="mt-1 text-sm text-fg-secondary">{t("description")}</p>
            <p className="mt-2 text-sm text-fg-secondary">{t("dependency")}</p>
            {settings && (
              <p className="mt-2 text-sm font-medium text-fg">{t(enabled ? "on" : "off")}</p>
            )}
            {hasGoogleKey === false && (
              <p className="mt-2 text-sm text-fg-secondary">
                {t("missingKey")}{" "}
                <Link href={`/${locale}/settings`} className="font-medium text-accent underline">
                  {t("openSettings")}
                </Link>
              </p>
            )}
            {settings?.blockedReason && (
              <p className="mt-2 text-sm text-fg-secondary">
                {t(REASON_KEYS[settings.blockedReason])}
              </p>
            )}
          </div>
          {settings && canManage && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => (enabled ? void saveConsent(false) : setConfirm(true))}
            >
              {busy ? t("saving") : t(enabled ? "disable" : "enable")}
            </Button>
          )}
        </div>
        {settings && (
          <div className="mt-4 border-t border-border-soft pt-4">
            <p className="text-sm font-medium text-fg">{t("brandThresholdTitle")}</p>
            <p className="mt-1 text-sm text-fg-secondary">{t("brandThresholdHint")}</p>
            <p className="mt-2 text-sm text-fg-secondary">
              {t("todayAdmitted", { amount: formatUsd(settings.admittedCostUsd) })}
            </p>
            {kind === "source" ? (
              <div id="paid-reply-brand-threshold" className="mt-3 flex flex-wrap items-end gap-3">
                {canManage ? (
                  <>
                    <Input
                      label={t("brandThresholdLabel")}
                      type="number"
                      min="0.01"
                      max="5"
                      step="0.01"
                      inputMode="decimal"
                      value={amount}
                      onChange={(event) => setAmount(event.target.value)}
                      className="w-32"
                    />
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void saveThreshold()}
                    >
                      {t("save")}
                    </Button>
                  </>
                ) : (
                  <p className="text-sm text-fg-secondary">
                    {t("brandThresholdValue", { amount: formatUsd(settings.dailyThresholdUsd) })}
                  </p>
                )}
              </div>
            ) : (
              <p className="mt-2 text-sm text-fg-secondary">
                {t("brandThresholdValue", { amount: formatUsd(settings.dailyThresholdUsd) })}{" "}
                <Link
                  href={`/${locale}/brands/${brandId}/sources#paid-reply-brand-threshold`}
                  className="font-medium text-accent underline"
                >
                  {t("editOnSources")}
                </Link>
              </p>
            )}
            <p className="mt-2 text-xs text-fg-tertiary">{t("estimateNote")}</p>
          </div>
        )}
        {notice && (
          <p role="status" className="mt-3 text-sm text-fg-secondary">
            {notice}
          </p>
        )}
        {error && (
          <div role="alert" className="mt-3 flex flex-wrap items-center gap-3 text-sm text-danger">
            <span>{error}</span>
            {!settings && (
              <Button variant="secondary" onClick={() => void load()}>
                {t("retry")}
              </Button>
            )}
          </div>
        )}
      </Card>
      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title={t("confirmTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirm(false)}>
              {t("cancel")}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => void saveConsent(true)}>
              {t("enable")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-fg-secondary">{t("confirmBody")}</p>
      </Modal>
    </>
  );
}
