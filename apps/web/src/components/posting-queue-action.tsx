"use client";

import {
  contentApproveSchema,
  type PostingQueuePreviewDto,
  postingQueuePreviewDtoSchema,
} from "@pubrick/shared";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import { Button } from "./ui/button";
import { Modal } from "./ui/modal";

export function PostingQueueAction({
  contentItemId,
  brandId,
  reviewFingerprint,
  disabled,
  onScheduled,
}: {
  contentItemId: string;
  brandId: string;
  reviewFingerprint: string;
  disabled: boolean;
  onScheduled: () => Promise<void>;
}) {
  const t = useTranslations("PostingSchedule");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const [snapshot, setSnapshot] = useState<{
    fingerprint: string;
    value: PostingQueuePreviewDto;
  } | null>(null);
  const preview = !disabled && snapshot?.fingerprint === reviewFingerprint ? snapshot.value : null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const current = useRef({ reviewFingerprint, disabled });
  current.current = { reviewFingerprint, disabled };
  useEffect(() => {
    if (disabled || (snapshot !== null && snapshot.fingerprint !== reviewFingerprint))
      setSnapshot(null);
  }, [disabled, reviewFingerprint, snapshot]);
  async function load() {
    if (busy || disabled) return;
    setError(null);
    setNotice(null);
    setBusy(true);
    const expected = reviewFingerprint;
    try {
      const result = postingQueuePreviewDtoSchema.parse(
        await api(`/api/content/${contentItemId}/posting-queue/preview`, {
          method: "POST",
          body: JSON.stringify({ reviewFingerprint: expected }),
        }),
      );
      if (current.current.reviewFingerprint !== expected || current.current.disabled) return;
      setSnapshot({ fingerprint: expected, value: result });
    } catch (cause) {
      setError(errorMessage(cause, t("previewError"), te));
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (!preview || busy || current.current.disabled) return;
    setError(null);
    setBusy(true);
    try {
      const payload = contentApproveSchema.parse({ queuePreviewToken: preview.token });
      await api(`/api/content/${contentItemId}/approve`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setSnapshot(null);
      setNotice(t("queued"));
      try {
        await onScheduled();
      } catch (cause) {
        setError(errorMessage(cause, t("refreshError"), te));
      }
    } catch (cause) {
      setSnapshot(null);
      setError(errorMessage(cause, t("previewError"), te));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="my-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" disabled={disabled || busy} onClick={load}>
          {busy ? t("loading") : t("addToQueue")}
        </Button>
        <Link
          href={`/${locale}/brands/${brandId}#channels`}
          className="text-sm text-accent underline"
        >
          {t("configure")}
        </Link>
      </div>
      <p className="mt-2 text-sm text-fg-secondary">{t("queueHint")}</p>
      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-3 text-sm text-fg-secondary">
          {notice}
        </p>
      )}
      <Modal
        open={preview !== null}
        title={t("confirmTitle")}
        onClose={() => {
          if (!busy) setSnapshot(null);
        }}
        footer={
          <Button disabled={busy || disabled} onClick={confirm}>
            {t("confirm")}
          </Button>
        }
      >
        <p className="mb-3 text-sm text-fg-secondary">{t("confirmHint")}</p>
        <ul className="space-y-3">
          {preview?.destinations.map((destination) => (
            <li key={destination.adaptationId}>
              <p className="font-semibold">{destination.channelName}</p>
              <time dateTime={destination.scheduledAt} className="text-sm text-fg-secondary">
                {new Intl.DateTimeFormat(locale, {
                  dateStyle: "medium",
                  timeStyle: "short",
                  timeZone: destination.timezone,
                }).format(new Date(destination.scheduledAt))}{" "}
                · {destination.timezone}
              </time>
            </li>
          ))}
        </ul>
      </Modal>
    </div>
  );
}
