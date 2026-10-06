"use client";

import {
  type ContentBatchReviewDto,
  contentBatchReviewDtoSchema,
  contentBatchReviewResultSchema,
} from "@pubrick/shared";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Modal } from "@/components/ui/modal";
import { ApiError, api, errorMessage } from "@/lib/api";

type Props = {
  open: boolean;
  brandId: string;
  itemIds: string[];
  onClose: () => void;
  onQueued: () => Promise<unknown>;
};

/** Review saved versions explicitly; loading a preview never marks a post opened. */
export function BatchReview({ open, brandId, itemIds, onClose, onQueued }: Props) {
  const t = useTranslations("BatchReview");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const [preview, setPreview] = useState<ContentBatchReviewDto | null>(null);
  const [brandName, setBrandName] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const [busy, setBusy] = useState<"load" | "confirm" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [queuedCount, setQueuedCount] = useState<number | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const generation = useRef(0);
  const selectionKey = JSON.stringify(itemIds);
  const describe = useRef((err: unknown) => errorMessage(err, t("failed"), te));
  useEffect(() => {
    describe.current = (err) => errorMessage(err, t("failed"), te);
  }, [t, te]);

  const reload = useCallback(async () => {
    const at = ++generation.current;
    setBusy("load");
    setPreview(null);
    setAcknowledged([]);
    setError(null);
    setQueuedCount(null);
    setRefreshFailed(false);
    try {
      const [brand, result] = await Promise.all([
        api<{ name: string }>(`/api/brands/${brandId}`, { cache: "no-store" }),
        api(`/api/brands/${brandId}/content/batch-review/preview`, {
          method: "POST",
          body: JSON.stringify({ itemIds: JSON.parse(selectionKey) as string[] }),
        }),
      ]);
      if (generation.current !== at) return;
      const snapshot = contentBatchReviewDtoSchema.parse(result);
      const expected = JSON.parse(selectionKey) as string[];
      if (
        snapshot.brandId !== brandId ||
        snapshot.items.length !== expected.length ||
        snapshot.items.some((item, i) => item.id !== expected[i])
      )
        throw new Error("Mismatched batch preview");
      setBrandName(brand.name);
      setPreview(snapshot);
    } catch (err) {
      if (generation.current === at) setError(describe.current(err));
    } finally {
      if (generation.current === at) setBusy(null);
    }
  }, [brandId, selectionKey]);

  useEffect(() => {
    setBrandName(null);
    if (open) void reload();
    else {
      setPreview(null);
      setAcknowledged([]);
    }
    return () => {
      generation.current += 1;
    };
  }, [open, reload]);

  async function confirm() {
    if (
      !preview?.token ||
      busy ||
      queuedCount !== null ||
      acknowledged.length !== preview.items.length
    )
      return;
    const at = ++generation.current;
    setBusy("confirm");
    setError(null);
    try {
      const receipt = contentBatchReviewResultSchema.parse(
        await api(`/api/brands/${brandId}/content/batch-review/confirm`, {
          method: "POST",
          body: JSON.stringify({
            token: preview.token,
            reviewed: preview.items.map(({ id, fingerprint }) => ({ id, fingerprint })),
          }),
        }),
      );
      if (generation.current !== at) return;
      setQueuedCount(receipt.items.length);
      setPreview(null);
      setAcknowledged([]);
      // A known queued write stays successful if the following queue read fails.
      try {
        await onQueued();
      } catch {
        if (generation.current === at) setRefreshFailed(true);
      }
    } catch (err) {
      if (generation.current !== at) return;
      // Unknown writes and stale/forbidden snapshots require a fresh review.
      setPreview(null);
      setAcknowledged([]);
      setError(describe.current(err));
    } finally {
      if (generation.current === at) setBusy(null);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        if (busy !== "confirm") onClose();
      }}
      title={t("title")}
      footer={
        <>
          <Button
            variant="ghost"
            className="min-h-11"
            disabled={busy === "confirm"}
            onClick={onClose}
          >
            {t("close")}
          </Button>
          {queuedCount === null && (
            <Button
              className="min-h-11"
              disabled={
                !preview?.token || busy !== null || acknowledged.length !== preview.items.length
              }
              onClick={confirm}
            >
              {busy === "confirm" ? t("queuing") : t("approve")}
            </Button>
          )}
        </>
      }
    >
      {brandName && (
        <p className="mb-3 break-words text-sm font-semibold text-fg">
          {t("brand", { name: brandName })}
        </p>
      )}
      <p className="mb-4 text-sm text-fg-secondary">{t("hint")}</p>
      {busy === "load" && <p role="status">{t("loading")}</p>}
      {queuedCount !== null && (
        <p role="status" className="mb-3 text-sm text-fg">
          {t("queued", { count: queuedCount })}
        </p>
      )}
      {refreshFailed && (
        <p role="alert" className="mb-3 text-sm text-danger">
          {t("refreshFailed")}
        </p>
      )}
      {error && (
        <p role="alert" className="mb-3 text-sm text-danger">
          {error}
        </p>
      )}
      {preview && (
        <div className="space-y-4">
          {preview.items.map((item) => (
            <Card key={item.id}>
              <h3 className="mb-2 break-words font-semibold text-fg">
                {item.title ?? t("untitled")}
              </h3>
              <h4 className="mb-1 text-xs font-semibold text-fg-secondary">{t("master")}</h4>
              {item.richBodyHtml ? (
                <div
                  className="prose max-w-none break-words text-sm text-fg [&_a]:text-accent [&_li]:ml-4 [&_ol]:list-decimal [&_ul]:list-disc"
                  // biome-ignore lint/security/noDangerouslySetInnerHtml: API renders validated rich documents with maintained Tiptap and sanitize-html allowlists.
                  dangerouslySetInnerHTML={{ __html: item.richBodyHtml }}
                />
              ) : (
                <p className="whitespace-pre-wrap break-words text-sm text-fg">{item.body}</p>
              )}
              {item.destinations.map((destination) => (
                <section
                  key={destination.adaptationId}
                  className="mt-4 border-t border-border-soft pt-3"
                >
                  <h4 className="break-words text-sm font-semibold">
                    {t("destination", { name: destination.name, platform: destination.platform })}
                  </h4>
                  {destination.connectionTarget && (
                    <p className="mt-1 break-all text-xs text-fg-secondary">
                      {destination.connectionTarget}
                    </p>
                  )}
                  <p className="mt-2 whitespace-pre-wrap break-words text-sm text-fg">
                    {destination.body}
                  </p>
                  {destination.hashtags.length > 0 && (
                    <p className="mt-2 break-words text-xs text-fg-secondary">
                      {t("hashtags", { text: destination.hashtags.join(" ") })}
                    </p>
                  )}
                  {destination.cta && (
                    <p className="mt-1 break-words text-xs text-fg-secondary">
                      {t("cta", { text: destination.cta })}
                    </p>
                  )}
                </section>
              ))}
              {item.media.map((media) => (
                <figure
                  key={`${media.id}-${media.placement}-${media.afterParagraph}`}
                  className="mt-3"
                >
                  <figcaption className="mb-2 break-words text-xs text-fg-secondary">
                    {t(`media.${media.placement}`)}
                    {media.afterParagraph !== null
                      ? ` · ${t("paragraph", { number: media.afterParagraph })}`
                      : ""}
                    {media.caption ? ` · ${media.caption}` : ""}
                  </figcaption>
                  {media.kind === "image" ? (
                    // biome-ignore lint/performance/noImgElement: authenticated media uses a same-origin credentialed endpoint, matching the editor preview.
                    <img
                      src={`/api/media/${media.id}/file`}
                      alt={media.alt}
                      className="max-h-56 max-w-full rounded-control object-contain"
                    />
                  ) : (
                    // biome-ignore lint/a11y/useMediaCaption: Uploaded clips have no caption track in this milestone; the exact written post remains visible above.
                    <video
                      src={`/api/media/${media.id}/file`}
                      controls
                      preload="none"
                      playsInline
                      aria-label={t("media.video")}
                      className="max-h-56 max-w-full"
                    />
                  )}
                </figure>
              ))}
              {item.blocker ? (
                <div className="mt-3">
                  <p role="alert" className="text-sm text-danger">
                    {errorMessage(
                      new ApiError(409, item.blocker.message, false, item.blocker.code),
                      item.blocker.message,
                      te,
                    )}
                  </p>
                  <Link
                    className="inline-flex min-h-11 items-center text-sm font-semibold text-accent"
                    href={`/${locale}/content/${item.id}`}
                  >
                    {t("openEditor")}
                  </Link>
                </div>
              ) : (
                <label className="mt-3 flex min-h-11 items-start gap-2 text-sm text-fg">
                  <input
                    type="checkbox"
                    className="mt-1 h-4 w-4 shrink-0"
                    checked={acknowledged.includes(item.id)}
                    disabled={busy !== null}
                    onChange={(event) =>
                      setAcknowledged((ids) =>
                        event.target.checked
                          ? [...ids, item.id]
                          : ids.filter((id) => id !== item.id),
                      )
                    }
                  />
                  {t("acknowledge", { title: item.title ?? t("untitled") })}
                </label>
              )}
            </Card>
          ))}
        </div>
      )}
      {queuedCount === null && busy !== "load" && (
        <Button
          variant="secondary"
          className="mt-4 min-h-11"
          onClick={reload}
          disabled={busy !== null}
        >
          {t("reload")}
        </Button>
      )}
    </Modal>
  );
}
