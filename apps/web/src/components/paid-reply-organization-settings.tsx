"use client";

import { formatUsd, type OrganizationPaidReplySettingsDto } from "@pubrick/shared";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Input } from "./ui/input";

export function PaidReplyOrganizationSettings({ canManage }: { canManage: boolean }) {
  const t = useTranslations("PaidReplies");
  const te = useTranslations("Errors");
  const [settings, setSettings] = useState<OrganizationPaidReplySettingsDto | null>(null);
  const [timezone, setTimezone] = useState("UTC");
  const [amount, setAmount] = useState("5.00");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const value = await api<OrganizationPaidReplySettingsDto>("/api/paid-replies/organization");
      setSettings(value);
      setTimezone(value.timezone);
      setAmount(value.dailyThresholdUsd.toFixed(2));
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause, t("loadError"), te));
    }
  }, [t, te]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    const dailyThresholdUsd = Number(amount);
    let validTimezone = false;
    try {
      new Intl.DateTimeFormat("en", { timeZone: timezone.trim() });
      validTimezone = true;
    } catch {
      // Keep validation next to the editor; the API also validates before persisting.
    }
    if (
      !validTimezone ||
      !/^\d+(?:\.\d{1,2})?$/.test(amount) ||
      dailyThresholdUsd < 0.01 ||
      dailyThresholdUsd > 5
    ) {
      setError(t("orgInvalid"));
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await api<OrganizationPaidReplySettingsDto>("/api/paid-replies/organization", {
        method: "PUT",
        body: JSON.stringify({ timezone: timezone.trim(), dailyThresholdUsd }),
      });
      setSettings(next);
      setTimezone(next.timezone);
      setAmount(next.dailyThresholdUsd.toFixed(2));
      setNotice(t("orgSaved"));
    } catch (cause) {
      setError(errorMessage(cause, t("saveError"), te));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="text-base font-semibold text-fg">{t("orgTitle")}</h2>
      <p className="mt-1 text-sm text-fg-secondary">{t("orgDescription")}</p>
      {settings && (
        <>
          <p className="mt-3 text-sm text-fg-secondary">
            {t("todayAdmitted", { amount: formatUsd(settings.admittedCostUsd) })}
          </p>
          {settings.blockedReason && (
            <p className="mt-2 text-sm text-fg-secondary">{t("orgBlocked")}</p>
          )}
          {canManage ? (
            <div className="mt-4 flex flex-wrap items-end gap-3">
              <Input
                label={t("timezoneLabel")}
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
                autoComplete="off"
                className="w-44"
              />
              <Input
                label={t("orgThresholdLabel")}
                type="number"
                min="0.01"
                max="5"
                step="0.01"
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                className="w-32"
              />
              <Button variant="secondary" disabled={busy} onClick={() => void save()}>
                {busy ? t("saving") : t("save")}
              </Button>
            </div>
          ) : (
            <p className="mt-3 text-sm text-fg-secondary">
              {t("orgReadOnly", {
                timezone: settings.timezone,
                amount: formatUsd(settings.dailyThresholdUsd),
              })}
            </p>
          )}
          <p className="mt-3 text-xs text-fg-tertiary">{t("estimateNote")}</p>
        </>
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
  );
}
