"use client";

import type { AutopilotManualAttempt } from "@pubrick/shared";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ListRow } from "@/components/ui/list-row";
import { Modal } from "@/components/ui/modal";
import { StatusBadge } from "@/components/ui/status-badge";
import { ApiError, api, errorMessage } from "@/lib/api";

export function AutopilotManualTrigger({
  brandId,
  disabled,
}: {
  brandId: string;
  disabled: boolean;
}) {
  const t = useTranslations("Autopilot");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const [attempts, setAttempts] = useState<AutopilotManualAttempt[]>([]);
  const [loading, setLoading] = useState(true);
  const [available, setAvailable] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const load = useCallback(async () => {
    try {
      const next = await api<AutopilotManualAttempt[]>(`/api/brands/${brandId}/autopilot/attempts`);
      setAttempts(next);
      setAvailable(true);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
        setAvailable(false);
        return;
      }
      setError(errorMessage(err, t("triggerHistoryError"), te));
    } finally {
      setLoading(false);
    }
  }, [brandId, t, te]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const latest = attempts[0];
  const active = latest?.status === "queued" || latest?.status === "running";
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(timer);
  }, [active, load]);
  const cooldown = !!latest && now - new Date(latest.createdAt).getTime() < 60_000;

  if (!available) return null;

  async function trigger() {
    if (disabled || active || cooldown || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const attempt = await api<AutopilotManualAttempt>(
        `/api/brands/${brandId}/autopilot/trigger`,
        { method: "POST" },
      );
      setAttempts((current) =>
        [attempt, ...current.filter((entry) => entry.id !== attempt.id)].slice(0, 20),
      );
      setOpen(false);
    } catch (err) {
      setOpen(false);
      const message = errorMessage(err, t("triggerError"), te);
      await load();
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section aria-labelledby="autopilot-manual-title" className="mt-8">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="autopilot-manual-title" className="text-lg font-semibold text-fg">
          {t("triggerTitle")}
        </h2>
        <Button
          variant="secondary"
          disabled={loading || submitting || disabled || active || cooldown}
          onClick={() => setOpen(true)}
        >
          {t("triggerAction")}
        </Button>
      </div>
      <p className="mb-3 text-sm text-fg-secondary">{t("triggerHint")}</p>
      {disabled && <p className="mb-3 text-xs text-fg-secondary">{t("triggerSaveFirst")}</p>}
      {cooldown && !active && (
        <p role="status" className="mb-3 text-xs text-fg-secondary">
          {t("triggerCooldown")}
        </p>
      )}
      {error && (
        <p role="alert" className="mb-3 text-sm text-danger">
          {error}
        </p>
      )}
      <Card padded={false}>
        {attempts.length === 0 ? (
          <EmptyState title={t("triggerEmpty")} />
        ) : (
          attempts.map((entry) => (
            <ListRow
              key={entry.id}
              title={
                entry.runId ? (
                  <Link
                    className="text-accent underline"
                    href={`/${locale}/content/runs/${entry.runId}`}
                  >
                    {t("triggerRun")}
                  </Link>
                ) : (
                  t(`triggerDecision.${entry.decision ?? entry.status}`)
                )
              }
              meta={new Date(entry.createdAt).toLocaleString(locale)}
              trailing={
                <StatusBadge
                  status={
                    entry.status === "failed"
                      ? "failed"
                      : entry.decision === "dispatched"
                        ? "draft"
                        : entry.status === "completed"
                          ? "review"
                          : "scheduled"
                  }
                >
                  {t(`triggerStatus.${entry.status}`)}
                </StatusBadge>
              }
            />
          ))
        )}
      </Card>
      <Modal
        open={open}
        onClose={() => {
          if (!submitting) setOpen(false);
        }}
        title={t("triggerConfirmTitle")}
        footer={
          <>
            <Button variant="secondary" disabled={submitting} onClick={() => setOpen(false)}>
              {t("cancel")}
            </Button>
            <Button disabled={submitting} onClick={() => void trigger()}>
              {submitting ? t("triggerRequesting") : t("triggerConfirm")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-fg-secondary">{t("triggerConfirmBody")}</p>
      </Modal>
    </section>
  );
}
