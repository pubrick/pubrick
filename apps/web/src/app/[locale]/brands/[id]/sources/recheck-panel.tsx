"use client";

import {
  type NewsRecheckBatch,
  type NewsRecheckPreview,
  newsRecheckRequestSchema,
} from "@pubrick/shared";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { Advanced } from "@/components/ui/advanced";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import { StatusBadge } from "@/components/ui/status-badge";
import { ApiError, api, errorMessage } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

function isActive(status: NewsRecheckBatch["status"] | null | undefined) {
  return status === "queued" || status === "running" || status === "halting";
}

export function RecheckPanel({ brandId, onFinished }: { brandId: string; onFinished: () => void }) {
  const t = useTranslations("Sources");
  const te = useTranslations("Errors");
  const { data: session } = authClient.useSession();
  const { data: organization } = authClient.useActiveOrganization();
  const member = organization?.members?.find(
    (entry) => entry.userId === session?.user.id || entry.user?.id === session?.user.id,
  );
  const canManage = member?.role === "owner" || member?.role === "admin";
  const [days, setDays] = useState(7);
  const [preview, setPreview] = useState<NewsRecheckPreview | null>(null);
  const [batch, setBatch] = useState<NewsRecheckBatch | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const priorStatus = useRef<NewsRecheckBatch["status"] | null>(null);

  const loadBatch = useCallback(async () => {
    const { batch: next } = await api<{ batch: NewsRecheckBatch | null }>(
      `/api/sources/items/recheck?brandId=${brandId}`,
    );
    if (isActive(priorStatus.current) && next && !isActive(next.status)) onFinished();
    priorStatus.current = next?.status ?? null;
    setBatch(next);
  }, [brandId, onFinished]);

  useEffect(() => {
    if (!canManage) return;
    void loadBatch().catch(() => setError(t("recheckLoadError")));
  }, [canManage, loadBatch, t]);

  useEffect(() => {
    if (!canManage || !isActive(batch?.status)) return;
    const timer = window.setInterval(() => {
      void loadBatch().catch(() => setError(t("recheckLoadError")));
    }, 5000);
    return () => window.clearInterval(timer);
  }, [canManage, batch, loadBatch, t]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setPreview(null);
    api<NewsRecheckPreview>(`/api/sources/items/recheck/preview?brandId=${brandId}&days=${days}`)
      .then((next) => {
        if (alive) {
          setPreview(next);
          setError(null);
        }
      })
      .catch((cause) => {
        if (alive) setError(errorMessage(cause, t("recheckLoadError"), te));
      });
    return () => {
      alive = false;
    };
  }, [brandId, days, open, t, te]);

  if (!canManage) return null;
  const active = isActive(batch?.status);

  async function start() {
    if (!preview || preview.eligible === 0) return;
    setBusy(true);
    setError(null);
    try {
      const request = newsRecheckRequestSchema.parse({ days, maxItems: preview.eligible });
      const next = await api<NewsRecheckBatch>(`/api/sources/items/recheck?brandId=${brandId}`, {
        method: "POST",
        body: JSON.stringify(request),
      });
      setBatch(next);
      priorStatus.current = next.status;
      setOpen(false);
    } catch (cause) {
      setError(errorMessage(cause, t("recheckLoadError"), te));
      if (cause instanceof ApiError && cause.code === "recheck_preview_stale") {
        setPreview(null);
        setOpen(false);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Advanced label={t("recheckAdvanced")} className="mb-4">
        <div className="space-y-3 border-t border-border p-4 text-sm">
          <p className="text-fg-secondary">{t("recheckHint")}</p>
          <Button variant="secondary" disabled={active || busy} onClick={() => setOpen(true)}>
            {t("recheck")}
          </Button>
        </div>
      </Advanced>
      {batch && (
        <div role="status" className="mb-4 space-y-1 text-sm">
          <StatusBadge
            status={
              batch.status === "halted"
                ? "failed"
                : active
                  ? "scheduled"
                  : batch.status === "partial"
                    ? "review"
                    : "published"
            }
          >
            {t(`recheckStatus_${batch.status}`)}
          </StatusBadge>
          <p>
            {t("recheckProgress", {
              processed: batch.processedCount,
              total: batch.selectedCount,
              updated: batch.updatedCount,
              failed: batch.failedCount,
              skipped: batch.skippedCount,
            })}
          </p>
          {batch.unrecordedCalls > 0 && (
            <p>{t("recheckUsageUnknown", { count: batch.unrecordedCalls })}</p>
          )}
          {batch.errorCode && (
            <p className="text-fg-secondary">{t(`recheckError_${batch.errorCode}`)}</p>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="mb-4 text-danger">
          {error}
        </p>
      )}
      <Modal
        open={open}
        onClose={() => {
          if (!busy) setOpen(false);
        }}
        title={t("recheckConfirmTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>
              {t("cancel")}
            </Button>
            <Button
              disabled={busy || !preview || preview.eligible === 0 || !preview.model}
              onClick={start}
            >
              {t(busy ? "recheckStarting" : "recheckStart")}
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <Select
            label={t("recheckDays")}
            value={days}
            onChange={(event) => setDays(Number(event.target.value))}
          >
            {[1, 7, 14, 30].map((value) => (
              <option key={value} value={value}>
                {t("recheckDaysOption", { count: value })}
              </option>
            ))}
          </Select>
          {preview ? (
            <>
              <p>{t("recheckEstimate", { count: preview.eligible })}</p>
              {preview.capped && <p>{t("recheckCapped")}</p>}
              <p>
                {t("recheckCallCap", {
                  model: preview.maxModelCalls,
                  embedding: preview.maxEmbeddingCalls,
                })}
              </p>
              <p>
                {preview.estimatedCostUsd === null
                  ? t("recheckUnknownCost")
                  : t("recheckModelCost", { amount: preview.estimatedCostUsd.toFixed(4) })}
              </p>
              <p className="text-fg-secondary">{t("recheckCostCaveat")}</p>
              {!preview.model && <p>{t("recheckNoKey")}</p>}
            </>
          ) : (
            <p>{t("recheckLoading")}</p>
          )}
        </div>
      </Modal>
    </>
  );
}
