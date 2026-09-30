"use client";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "@/lib/api";
import {
  type BillingPlan,
  type BillingStatus,
  billing,
  billingDestination,
  billingPrice,
} from "@/lib/billing";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Select } from "./ui/select";
import { Skeleton } from "./ui/skeleton";
import { StatusBadge, type StatusBadgeStatus } from "./ui/status-badge";

const tones: Record<BillingStatus["status"], StatusBadgeStatus> = {
  unconfigured: "draft",
  pending: "review",
  active: "published",
  trial: "scheduled",
  expired: "failed",
  cancelled: "draft",
  past_due: "failed",
};
const metrics = ["seats", "brands", "channels", "mediaBytes", "concurrentJobs"] as const;
export function BillingCard({ orgId, testMode }: { orgId: string; testMode: boolean }) {
  const t = useTranslations("BillingCard");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [plans, setPlans] = useState<BillingPlan[]>([]);
  const [planId, setPlanId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lifetime = useRef(0);
  const requestSequence = useRef(0);
  const refresh = useCallback(async () => {
    const identity = lifetime.current;
    const request = ++requestSequence.current;
    try {
      const [nextStatus, nextPlans] = await Promise.all([billing.status(), billing.plans()]);
      if (identity !== lifetime.current || request !== requestSequence.current) return;
      setStatus(nextStatus);
      setPlans(nextPlans);
      setError(null);
      setPlanId((current) =>
        nextPlans.some((plan) => plan.id === current) ? current : (nextPlans[0]?.id ?? ""),
      );
    } catch (err) {
      if (identity === lifetime.current && request === requestSequence.current)
        setError(errorMessage(err, t("error"), te));
    }
  }, [t, te]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: org switch invalidates old asynchronous responses.
  useEffect(() => {
    lifetime.current += 1;
    setBusy(false);
    setStatus(null);
    setPlans([]);
    setPlanId("");
    setError(null);
    void refresh();
    return () => {
      lifetime.current += 1;
    };
  }, [orgId, refresh]);
  useEffect(() => {
    if (status?.status !== "pending") return;
    // A return URL grants nothing: only the persisted server status ends polling.
    let attempts = 0;
    const timer = setInterval(() => {
      if (++attempts > 20) clearInterval(timer);
      else void refresh();
    }, 3000);
    return () => clearInterval(timer);
  }, [status?.status, refresh]);
  async function openSession(portal: boolean) {
    if (
      busy ||
      !status?.canManage ||
      (!portal && !planId) ||
      !testMode ||
      (portal ? !status.portalAvailable : !status.checkoutAvailable)
    )
      return;
    const identity = lifetime.current;
    setBusy(true);
    setError(null);
    try {
      const session = portal
        ? await billing.portal(locale)
        : await billing.checkout(planId, locale);
      if (identity !== lifetime.current) return;
      window.location.assign(billingDestination(session.url, testMode));
    } catch (err) {
      if (identity === lifetime.current) setError(errorMessage(err, t("error"), te));
    } finally {
      if (identity === lifetime.current) setBusy(false);
    }
  }
  const manage = status?.plan !== null && status?.plan !== undefined;
  const selected = plans.find((plan) => plan.id === planId);
  function metric(value: number, key: (typeof metrics)[number]) {
    return key === "mediaBytes"
      ? t("bytes", {
          value: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(
            value / 1024 / 1024,
          ),
        })
      : new Intl.NumberFormat(locale).format(value);
  }
  return (
    <Card className="flex flex-col gap-4" aria-labelledby="billing-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="billing-heading" className="text-base font-semibold">
          {t("title")}
        </h2>
        {testMode && <StatusBadge status="review">{t("sandbox")}</StatusBadge>}
      </div>
      <p className="text-sm text-fg-secondary">{t("byok")}</p>
      {testMode && <p className="text-sm text-fg-secondary">{t("sandboxHelp")}</p>}
      {!status && !error && <Skeleton lines={3} />}
      {status && (
        <>
          <div aria-live="polite" className="flex flex-wrap items-center gap-3">
            <StatusBadge status={tones[status.status]}>{t(`status_${status.status}`)}</StatusBadge>
            {status.plan && (
              <span className="text-sm">
                {t("currentPlan", { id: status.plan.id, version: status.plan.version })}
              </span>
            )}
          </div>
          {status.accessUntil && (
            <p className="text-sm text-fg-secondary">
              {t("accessUntil", {
                date: new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(
                  new Date(status.accessUntil),
                ),
              })}
            </p>
          )}
          {status.cancelAtPeriodEnd && (
            <p className="text-sm text-fg-secondary">{t("cancelScheduled")}</p>
          )}
          {status.status === "pending" && (
            <p role="status" className="text-sm text-fg-secondary">
              {t("pendingHelp")}
            </p>
          )}
          {status.status === "expired" && (
            <p className="text-sm text-fg-secondary">{t("expiredHelp")}</p>
          )}
          <dl className="grid gap-3 sm:grid-cols-2">
            {metrics.map((key) => (
              <div key={key} className="flex justify-between gap-3 text-sm">
                <dt className="text-fg-secondary">{t(key)}</dt>
                <dd>
                  {metric(status.usage[key], key)}
                  {status.limits ? ` / ${metric(status.limits[key], key)}` : ""}
                </dd>
              </div>
            ))}
          </dl>
          {status.canManage &&
            testMode &&
            (manage ? (
              <Button
                variant="secondary"
                disabled={busy || !status.portalAvailable}
                onClick={() => void openSession(true)}
                className="self-start"
              >
                {t("portal")}
              </Button>
            ) : plans.length > 0 ? (
              <div className="flex flex-col gap-3">
                <Select
                  label={t("plan")}
                  value={planId}
                  disabled={busy}
                  onChange={(event) => setPlanId(event.target.value)}
                >
                  {plans.map((plan) => (
                    <option key={plan.id} value={plan.id}>
                      {plan.id} · {t("version", { version: plan.version })}
                    </option>
                  ))}
                </Select>
                {selected && (
                  <p className="text-sm text-fg-secondary">
                    {t("price", {
                      price: billingPrice(selected, locale),
                      count: selected.intervalCount,
                      interval: t(`interval_${selected.interval}`),
                    })}
                  </p>
                )}
                <Button
                  disabled={
                    busy || !selected || !status.checkoutAvailable || status.status === "pending"
                  }
                  onClick={() => void openSession(false)}
                  className="self-start"
                >
                  {t("checkout")}
                </Button>
              </div>
            ) : (
              <p className="text-sm text-fg-secondary">{t("noPlans")}</p>
            ))}
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <Button variant="ghost" disabled={busy} onClick={() => void refresh()} className="self-start">
        {t("refresh")}
      </Button>
    </Card>
  );
}
