"use client";

import type { MediaAssetDto } from "@pubrick/shared";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, api, errorMessage } from "@/lib/api";

type ImageSlot = {
  id?: string;
  clientKey?: string;
  mediaId: string;
  afterParagraph: number;
  alt: string;
  caption: string | null;
  needsReview?: boolean;
};

type ImageState = { images: ImageSlot[]; revision: number };

/** One blank line separates editorial paragraphs; blank blocks are not positions. */
export function articleParagraphs(body: string): string[] {
  return body
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

const MAX_IMAGES = 5;

export function InlineImages({
  itemId,
  brandId,
  savedBody,
  bodyHasUnsavedChanges,
  editable,
  manualVc,
}: {
  itemId: string;
  brandId: string;
  savedBody: string;
  bodyHasUnsavedChanges: boolean;
  editable: boolean;
  manualVc: boolean;
}) {
  const t = useTranslations("InlineImages");
  const te = useTranslations("Errors");
  const paragraphs = articleParagraphs(savedBody);
  const paragraphPositions = paragraphs.map((text, position) => ({
    key: `${position}:${text}`,
    position,
  }));
  const [slots, setSlots] = useState<ImageSlot[]>([]);
  const [revision, setRevision] = useState(0);
  const [stale, setStale] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [reviewedSlots, setReviewedSlots] = useState<Set<string>>(new Set());
  const [bodyChangedWhileEditing, setBodyChangedWhileEditing] = useState(false);
  const [chooser, setChooser] = useState<{ replaceIndex: number | null } | null>(null);
  const [assets, setAssets] = useState<MediaAssetDto[]>([]);
  const [mediaOffset, setMediaOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [mediaLoading, setMediaLoading] = useState(false);
  const [hasGoogleKey, setHasGoogleKey] = useState(false);
  const [credentialsLoaded, setCredentialsLoaded] = useState(false);
  const [regeneratingSlotId, setRegeneratingSlotId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [sourceMediaId, setSourceMediaId] = useState<string | null>(null);
  const [newMediaId, setNewMediaId] = useState<string | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const nextKey = useRef(0);
  const lastSavedBody = useRef(savedBody);
  const requestVersion = useRef(0);

  const loadSlots = useCallback(async () => {
    const version = ++requestVersion.current;
    setLoading(true);
    try {
      const state = await api<ImageState>(`/api/content/${itemId}/images`, { cache: "no-store" });
      if (version !== requestVersion.current) return;
      setSlots(state.images);
      setRevision(state.revision);
      setDirty(false);
      setReviewedSlots(new Set());
      setStale(false);
      setError(null);
      setBodyChangedWhileEditing(false);
      setLoadError(null);
    } catch (cause) {
      if (version !== requestVersion.current) return;
      setLoadError(errorMessage(cause, t("loadFailed"), te));
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, [itemId, t, te]);

  // Positions refer to the saved body. Re-read after a body save so a second
  // editor cannot leave this tab showing placements against stale paragraphs.
  useEffect(() => {
    void loadSlots();
  }, [loadSlots]);

  useEffect(() => {
    if (lastSavedBody.current === savedBody) return;
    lastSavedBody.current = savedBody;
    if (dirty) {
      setBodyChangedWhileEditing(true);
    } else {
      void loadSlots();
    }
  }, [savedBody, dirty, loadSlots]);

  const loadAssets = useCallback(async () => {
    setMediaLoading(true);
    try {
      const page = await api<MediaAssetDto[]>(`/api/media?brandId=${brandId}`);
      const images = page.filter((asset) => asset.kind === "image");
      setAssets(images);
      setMediaOffset(page.length);
      setHasMore(page.length === 100);
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause, t("mediaFailed"), te));
    } finally {
      setMediaLoading(false);
    }
  }, [brandId, t, te]);

  useEffect(() => {
    if (!editable) return;
    void api<{ provider: string }[]>("/api/ai-credentials")
      .then((keys) => setHasGoogleKey(keys.some((key) => key.provider === "google")))
      .catch(() => setHasGoogleKey(false))
      .finally(() => setCredentialsLoaded(true));
  }, [editable]);

  useEffect(() => {
    if (chooser) void loadAssets();
  }, [chooser, loadAssets]);

  function changeSlot(index: number, update: Partial<ImageSlot>) {
    const id = slots[index]?.id;
    if (id && slots[index]?.needsReview) {
      setReviewedSlots((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
    setSlots((current) =>
      current.map((slot, at) => (at === index ? { ...slot, ...update } : slot)),
    );
    setDirty(true);
  }

  function choose(asset: MediaAssetDto) {
    if (!chooser || asset.kind !== "image") return;
    if (chooser.replaceIndex !== null) {
      // A description of the old picture cannot be trusted for its replacement.
      changeSlot(chooser.replaceIndex, { mediaId: asset.id, alt: "", caption: null });
    } else {
      const used = new Set(slots.map((slot) => slot.afterParagraph));
      const position = paragraphs.findIndex((_, index) => !used.has(index));
      if (position < 0) return;
      setSlots((current) => [
        ...current,
        {
          clientKey: `new-${nextKey.current++}`,
          mediaId: asset.id,
          afterParagraph: position,
          alt: "",
          caption: null,
        },
      ]);
      setDirty(true);
    }
    setChooser(null);
    setSourceMediaId(null);
    setPrompt("");
  }

  async function upload(file?: File) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const data = new FormData();
      data.append("file", file);
      const created = await api<MediaAssetDto>(`/api/media?brandId=${brandId}`, {
        method: "POST",
        body: data,
      });
      setNewMediaId(created.id);
      await loadAssets();
    } catch (cause) {
      setError(errorMessage(cause, t("uploadFailed"), te));
    } finally {
      setBusy(false);
    }
  }

  async function generate() {
    if (prompt.trim().length < 8 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api<MediaAssetDto>("/api/media/generate", {
        method: "POST",
        body: JSON.stringify({
          brandId,
          prompt: prompt.trim(),
          ...(sourceMediaId ? { sourceMediaId } : {}),
        }),
      });
      setNewMediaId(created.id);
      setPrompt("");
      setSourceMediaId(null);
      await loadAssets();
    } catch (cause) {
      setError(errorMessage(cause, t("generateFailed"), te));
    } finally {
      setBusy(false);
    }
  }

  async function regenerate(slotId: string) {
    if (busy || dirty || stale || bodyHasUnsavedChanges || !hasGoogleKey) return;
    setBusy(true);
    setRegeneratingSlotId(slotId);
    setError(null);
    try {
      const saved = await api<ImageState>(`/api/content/${itemId}/images/${slotId}/regenerate`, {
        method: "POST",
        body: JSON.stringify({ expectedRevision: revision, expectedBody: savedBody }),
      });
      setSlots(saved.images);
      setRevision(saved.revision);
      setDirty(false);
      setReviewedSlots(new Set());
      setStale(false);
      setBodyChangedWhileEditing(false);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "content_images_changed") setStale(true);
      setError(errorMessage(cause, t("regenerateFailed"), te));
    } finally {
      setBusy(false);
      setRegeneratingSlotId(null);
    }
  }

  async function loadMore() {
    setMediaLoading(true);
    try {
      const next = await api<MediaAssetDto[]>(
        `/api/media?brandId=${brandId}&offset=${mediaOffset}`,
      );
      setAssets((current) => [...current, ...next.filter((asset) => asset.kind === "image")]);
      setMediaOffset((current) => current + next.length);
      setHasMore(next.length === 100);
    } catch (cause) {
      setError(errorMessage(cause, t("mediaFailed"), te));
    } finally {
      setMediaLoading(false);
    }
  }

  async function save() {
    if (
      !editable ||
      bodyHasUnsavedChanges ||
      (!dirty && !pendingReview) ||
      busy ||
      stale ||
      invalidAlt ||
      invalidPosition ||
      unacknowledgedReview
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const saved = await api<ImageState>(`/api/content/${itemId}/images`, {
        method: "PUT",
        body: JSON.stringify({
          expectedRevision: revision,
          ...(pendingReview && { reviewGeneratedImages: true }),
          images: slots.map(({ mediaId, afterParagraph, alt, caption }) => ({
            mediaId,
            afterParagraph,
            alt: alt.trim(),
            ...(caption?.trim() ? { caption: caption.trim() } : {}),
          })),
        }),
      });
      setSlots(saved.images);
      setRevision(saved.revision);
      setDirty(false);
      setReviewedSlots(new Set());
      setStale(false);
      setBodyChangedWhileEditing(false);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "content_images_changed") setStale(true);
      setError(errorMessage(cause, t("saveFailed"), te));
    } finally {
      setBusy(false);
    }
  }

  const canAdd =
    editable &&
    !bodyHasUnsavedChanges &&
    paragraphs.length > 0 &&
    slots.length < Math.min(MAX_IMAGES, paragraphs.length);
  const invalidAlt = slots.some((slot) => slot.alt.trim().length === 0);
  const invalidPosition = slots.some((slot) => slot.afterParagraph >= paragraphs.length);
  const pendingReview = slots.some((slot) => slot.needsReview);
  const unacknowledgedReview = slots.some(
    (slot) => slot.needsReview && (!slot.id || !reviewedSlots.has(slot.id)),
  );

  return (
    <Card className="mb-6" aria-label={t("title")}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-fg">{t("title")}</h2>
          <p className="mt-1 text-sm text-fg-secondary">{t("hint")}</p>
          {manualVc && <p className="mt-1 text-sm text-fg-tertiary">{t("vcNote")}</p>}
        </div>
        {editable && (
          <div className="flex flex-wrap items-center gap-2">
            {dirty && (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void loadSlots()}>
                {t("discard")}
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              disabled={!canAdd || loading || busy}
              onClick={() => setChooser({ replaceIndex: null })}
            >
              {t("add")}
            </Button>
            <Button
              size="sm"
              disabled={
                (!dirty && !pendingReview) ||
                busy ||
                stale ||
                bodyHasUnsavedChanges ||
                invalidAlt ||
                invalidPosition ||
                unacknowledgedReview
              }
              onClick={() => void save()}
            >
              {busy && !regeneratingSlotId ? t("saving") : t("save")}
            </Button>
          </div>
        )}
      </div>
      {bodyHasUnsavedChanges && (
        <p className="mb-3 text-sm text-fg-secondary" role="status">
          {t("saveTextFirst")}
        </p>
      )}
      {bodyChangedWhileEditing && (
        <p className="mb-3 text-sm text-fg-secondary" role="status">
          {t("bodyChanged")}
        </p>
      )}
      {invalidPosition && (
        <p className="mb-3 text-sm text-danger" role="alert">
          {t("invalidPosition")}
        </p>
      )}
      {pendingReview && (
        <p className="mb-3 text-sm text-fg-secondary" role="status">
          {t("generatedReviewHint")}
        </p>
      )}
      {loadError && (
        <div className="mb-4 flex items-center gap-3">
          <p role="alert" className="text-sm text-danger">
            {loadError}
          </p>
          <Button size="sm" variant="secondary" onClick={() => void loadSlots()}>
            {t("retry")}
          </Button>
        </div>
      )}
      {!loading && !loadError && (
        <>
          {slots.length === 0 && <p className="mb-4 text-sm text-fg-tertiary">{t("empty")}</p>}
          {editable && slots.length > 0 && (
            <ul className="mb-5 space-y-3">
              {slots.map((slot, index) => (
                <li
                  key={slot.id ?? slot.clientKey}
                  className="rounded-control border border-border p-3"
                >
                  <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
                    {/* Authenticated, tenant-scoped file endpoint. */}
                    {/* biome-ignore lint/performance/noImgElement: session-bound media cannot use Next image optimization */}
                    <img
                      src={`/api/media/${slot.mediaId}/file`}
                      alt={slot.alt}
                      className="aspect-square w-full rounded-control bg-bg-sunken object-cover"
                    />
                    <div className="space-y-3">
                      {slot.needsReview && (
                        <p className="text-sm font-medium text-accent">
                          {t("generatedReviewBadge")}
                        </p>
                      )}
                      <Select
                        label={t("position")}
                        value={slot.afterParagraph}
                        disabled={busy || bodyHasUnsavedChanges}
                        onChange={(event) =>
                          changeSlot(index, { afterParagraph: Number(event.target.value) })
                        }
                      >
                        {slot.afterParagraph >= paragraphs.length && (
                          <option value={slot.afterParagraph} disabled>
                            {t("previousPosition", { number: slot.afterParagraph + 1 })}
                          </option>
                        )}
                        {paragraphPositions.map(({ key, position }) => (
                          <option
                            key={key}
                            value={position}
                            disabled={slots.some(
                              (other, otherIndex) =>
                                otherIndex !== index && other.afterParagraph === position,
                            )}
                          >
                            {t("afterParagraph", { number: position + 1 })}
                          </option>
                        ))}
                      </Select>
                      <Input
                        label={t("alt")}
                        value={slot.alt}
                        maxLength={300}
                        required
                        placeholder={t("altPlaceholder")}
                        disabled={busy}
                        onChange={(event) => changeSlot(index, { alt: event.target.value })}
                      />
                      <Input
                        label={t("caption")}
                        value={slot.caption ?? ""}
                        maxLength={500}
                        disabled={busy}
                        onChange={(event) =>
                          changeSlot(index, { caption: event.target.value || null })
                        }
                      />
                      {slot.needsReview && slot.id && (
                        <label className="flex items-start gap-2 text-sm text-fg-secondary">
                          <input
                            type="checkbox"
                            checked={reviewedSlots.has(slot.id)}
                            disabled={busy || bodyHasUnsavedChanges}
                            onChange={(event) => {
                              const slotId = slot.id;
                              if (!slotId) return;
                              setReviewedSlots((current) => {
                                const next = new Set(current);
                                if (event.target.checked) next.add(slotId);
                                else next.delete(slotId);
                                return next;
                              });
                            }}
                            className="mt-0.5 h-5 w-5 rounded border-border text-accent"
                          />
                          <span>{t("confirmGeneratedReview")}</span>
                        </label>
                      )}
                      <div className="flex flex-wrap gap-2">
                        {slot.id && (
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={
                              busy || dirty || stale || bodyHasUnsavedChanges || !hasGoogleKey
                            }
                            onClick={() => void regenerate(slot.id as string)}
                          >
                            {regeneratingSlotId === slot.id ? t("regenerating") : t("regenerate")}
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={busy || bodyHasUnsavedChanges}
                          onClick={() => setChooser({ replaceIndex: index })}
                        >
                          {t("replace")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => {
                            setSlots((current) => current.filter((_, at) => at !== index));
                            setDirty(true);
                          }}
                        >
                          {t("remove")}
                        </Button>
                      </div>
                      {slot.id && (
                        <p className="text-xs text-fg-tertiary">
                          {!hasGoogleKey && credentialsLoaded
                            ? t("regenerateNeedsGoogle")
                            : t("regenerateHint")}
                        </p>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {error && (
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
              {stale && (
                <Button size="sm" variant="secondary" onClick={() => void loadSlots()}>
                  {t("reloadLatest")}
                </Button>
              )}
            </div>
          )}
          {paragraphs.length > 0 && (
            <section
              aria-label={t("preview")}
              className="mt-5 rounded-control border border-border bg-bg-sunken p-4"
            >
              <h3 className="mb-3 text-sm font-semibold text-fg">{t("preview")}</h3>
              <div className="space-y-4">
                {paragraphs.map((paragraph, position) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: the ordinal is the paragraph's persisted identity
                  <div key={position}>
                    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-fg">
                      {paragraph}
                    </p>
                    {slots
                      .filter((slot) => slot.afterParagraph === position)
                      .map((slot) => (
                        <figure
                          key={slot.id ?? `${slot.mediaId}-${position}`}
                          className="mt-3 max-w-2xl"
                        >
                          {/* biome-ignore lint/performance/noImgElement: session-bound media cannot use Next image optimization */}
                          <img
                            src={`/api/media/${slot.mediaId}/file`}
                            alt={slot.alt}
                            className="max-h-96 w-full rounded-control object-contain"
                          />
                          {slot.caption && (
                            <figcaption className="mt-1 text-center text-xs text-fg-secondary">
                              {slot.caption}
                            </figcaption>
                          )}
                        </figure>
                      ))}
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}
      {chooser && (
        <section
          aria-label={t("chooseImage")}
          className="mt-5 rounded-control border border-border bg-bg-sunken p-3"
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-fg">{t("chooseImage")}</h3>
            <Button size="sm" variant="ghost" onClick={() => setChooser(null)}>
              {t("cancel")}
            </Button>
          </div>
          <input
            ref={uploadRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            aria-label={t("upload")}
            disabled={busy}
            onChange={(event) => {
              void upload(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => uploadRef.current?.click()}
          >
            {t("upload")}
          </Button>
          {hasGoogleKey && (
            <div className="mt-4 space-y-2">
              {sourceMediaId && <p className="text-xs text-fg-secondary">{t("variation")}</p>}
              <Textarea
                label={t("prompt")}
                value={prompt}
                maxLength={2000}
                disabled={busy}
                onChange={(event) => setPrompt(event.target.value)}
              />
              <Button
                size="sm"
                variant="secondary"
                disabled={busy || prompt.trim().length < 8}
                onClick={() => void generate()}
              >
                {busy ? t("generating") : t("generate")}
              </Button>
            </div>
          )}
          {mediaLoading ? (
            <p role="status" className="mt-3 text-sm text-fg-secondary">
              {t("loadingMedia")}
            </p>
          ) : (
            <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {assets.map((asset) => (
                <li
                  key={asset.id}
                  className="overflow-hidden rounded-control border border-border bg-panel"
                >
                  {/* biome-ignore lint/performance/noImgElement: session-bound media cannot use Next image optimization */}
                  <img
                    src={`/api/media/${asset.id}/file`}
                    alt={asset.name}
                    className="aspect-square w-full object-cover"
                  />
                  <div className="space-y-2 p-2">
                    <p className="truncate text-xs text-fg-secondary" title={asset.name}>
                      {asset.name}
                    </p>
                    {newMediaId === asset.id && (
                      <p role="status" className="text-xs text-accent">
                        {t("reviewNew")}
                      </p>
                    )}
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => choose(asset)}
                    >
                      {t("use")}
                    </Button>
                    {hasGoogleKey && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => setSourceMediaId(asset.id)}
                      >
                        {t("tryVariation")}
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {hasMore && (
            <Button
              size="sm"
              variant="secondary"
              disabled={mediaLoading || busy}
              className="mt-3"
              onClick={() => void loadMore()}
            >
              {t("more")}
            </Button>
          )}
        </section>
      )}
    </Card>
  );
}
