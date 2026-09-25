"use client";

import type { MediaAssetDto } from "@pubrick/shared";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Textarea } from "@/components/ui/textarea";
import { api, apiVoid, errorMessage } from "@/lib/api";

export function MediaLibrary({
  brandId,
  itemId,
  selectedId,
  selectedKind,
  editable = false,
  onChange,
  uploadInputId = "media-upload",
  showUploadButton = true,
}: {
  brandId: string;
  itemId?: string;
  selectedId?: string | null;
  selectedKind?: "image" | "video";
  editable?: boolean;
  onChange?: () => void;
  uploadInputId?: string;
  showUploadButton?: boolean;
}) {
  const t = useTranslations("Media");
  const te = useTranslations("Errors");
  const [assets, setAssets] = useState<MediaAssetDto[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hasGoogleKey, setHasGoogleKey] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [generatedId, setGeneratedId] = useState<string | null>(null);
  const promptRef = useRef<HTMLDivElement>(null);
  const load = useCallback(async () => {
    try {
      const first = await api<MediaAssetDto[]>(`/api/media?brandId=${brandId}`);
      setAssets(first);
      setHasMore(first.length === 100);
      setError(null);
      setLoadFailed(false);
    } catch (cause) {
      setError(errorMessage(cause, t("failed"), te));
      setLoadFailed(true);
    }
  }, [brandId, t, te]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    void api<{ googleConfigured: boolean }>("/api/ai-credentials/availability")
      .then((availability) => setHasGoogleKey(availability.googleConfigured))
      .catch(() => setHasGoogleKey(false));
  }, []);

  async function generate() {
    if (prompt.trim().length < 8 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const asset = await api<MediaAssetDto>("/api/media/generate", {
        method: "POST",
        body: JSON.stringify({
          brandId,
          prompt: prompt.trim(),
          ...(sourceId ? { sourceMediaId: sourceId } : {}),
        }),
      });
      setGeneratedId(asset.id);
      setPrompt("");
      setSourceId(null);
      await load();
    } catch (cause) {
      setError(errorMessage(cause, t("generateFailed"), te));
    } finally {
      setBusy(false);
    }
  }

  async function loadMore() {
    setBusy(true);
    try {
      const next = await api<MediaAssetDto[]>(
        `/api/media?brandId=${brandId}&offset=${assets.length}`,
      );
      setAssets((current) => [...current, ...next]);
      setHasMore(next.length === 100);
    } catch (cause) {
      setError(errorMessage(cause, t("failed"), te));
    } finally {
      setBusy(false);
    }
  }

  async function upload(file?: File) {
    if (!file) return;
    setBusy(true);
    try {
      const body = new FormData();
      body.append("file", file);
      await api(`/api/media?brandId=${brandId}`, { method: "POST", body });
      await load();
    } catch (cause) {
      setError(errorMessage(cause, t("failed"), te));
    } finally {
      setBusy(false);
    }
  }

  async function attach(mediaId: string | null, kind: "image" | "video") {
    if (!itemId || !editable) return;
    setBusy(true);
    try {
      await api(`/api/media/posts/${itemId}/${kind === "video" ? "video" : "cover"}`, {
        method: "PATCH",
        body: JSON.stringify({ mediaId }),
      });
      setError(null);
      onChange?.();
    } catch (cause) {
      setError(errorMessage(cause, t("failed"), te));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      await apiVoid(`/api/media/${id}`, { method: "DELETE" });
      await load();
    } catch (cause) {
      setError(errorMessage(cause, t("failed"), te));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mt-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t("title")}</h2>
          <p className="text-sm text-fg-secondary">{t("hint")}</p>
        </div>
        {showUploadButton && (
          <label
            htmlFor={uploadInputId}
            className="cursor-pointer text-sm font-medium text-accent underline"
          >
            {t("add")}
          </label>
        )}
      </div>
      <input
        id={uploadInputId}
        type="file"
        accept="image/jpeg,image/png,image/webp,video/mp4"
        className="sr-only"
        disabled={busy}
        onChange={(event) => {
          void upload(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
      {error && (
        <p role="alert" className="mb-3 text-sm text-danger">
          {error}
        </p>
      )}
      {hasGoogleKey && (
        <div
          ref={promptRef}
          className="mb-4 space-y-2 rounded-control border border-border bg-bg-sunken p-3"
        >
          <p className="text-sm font-medium">{t("generateTitle")}</p>
          <p className="text-xs text-fg-secondary">{t("generateHint")}</p>
          {sourceId && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-fg-secondary">
              <span>
                {t("variationOf", {
                  name: assets.find((asset) => asset.id === sourceId)?.name ?? t("image"),
                })}
              </span>
              <Button size="sm" variant="ghost" onClick={() => setSourceId(null)}>
                {t("cancelVariation")}
              </Button>
            </div>
          )}
          <Textarea
            label={t("prompt")}
            value={prompt}
            maxLength={2000}
            disabled={busy}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={sourceId ? t("variationPlaceholder") : t("promptPlaceholder")}
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || prompt.trim().length < 8}
            onClick={() => void generate()}
          >
            {busy ? t("generating") : sourceId ? t("generateVariation") : t("generate")}
          </Button>
        </div>
      )}
      {loadFailed ? (
        <Button size="sm" variant="secondary" onClick={() => void load()}>
          {t("retry")}
        </Button>
      ) : assets.length === 0 ? (
        <EmptyState
          title={t("empty")}
          action={
            showUploadButton ? (
              <label
                htmlFor={uploadInputId}
                className="cursor-pointer text-sm text-accent underline"
              >
                {t("add")}
              </label>
            ) : undefined
          }
        />
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {assets.map((asset) => (
            <li key={asset.id} className="overflow-hidden rounded-control border border-border">
              {asset.kind === "video" ? (
                // biome-ignore lint/a11y/useMediaCaption: The library stores the original MP4 without an optional caption sidecar.
                <video
                  src={`/api/media/${asset.id}/file`}
                  controls
                  preload="none"
                  playsInline
                  aria-label={asset.name}
                  className="aspect-square w-full bg-surface object-contain"
                />
              ) : (
                // Authenticated, tenant-scoped file endpoint.
                // biome-ignore lint/performance/noImgElement: this endpoint requires the signed-in session
                <img
                  src={`/api/media/${asset.id}/file`}
                  alt={asset.name}
                  className="aspect-square w-full object-cover"
                />
              )}
              <div className="space-y-2 p-2">
                <p className="truncate text-xs text-fg-secondary" title={asset.name}>
                  {asset.name}
                </p>
                {generatedId === asset.id && (
                  <p className="text-xs text-accent" role="status">
                    {t("reviewImage")}
                  </p>
                )}
                {itemId &&
                  (selectedId === asset.id ? (
                    <span className="text-xs font-medium text-accent">{t("selected")}</span>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!editable || busy}
                      onClick={() => void attach(asset.id, asset.kind)}
                    >
                      {t("use")}
                    </Button>
                  ))}
                {hasGoogleKey && asset.kind === "image" && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => {
                      setSourceId(asset.id);
                      setGeneratedId(null);
                      promptRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
                    }}
                  >
                    {t("tryVariation")}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy || selectedId === asset.id}
                  onClick={() => void remove(asset.id)}
                >
                  {t("remove")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {hasMore && (
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => void loadMore()}
          className="mt-3"
        >
          {t("more")}
        </Button>
      )}
      {itemId && selectedId && (
        <Button
          size="sm"
          variant="secondary"
          disabled={!editable || busy}
          onClick={() => void attach(null, selectedKind ?? "image")}
          className="mt-3"
        >
          {t("detach")}
        </Button>
      )}
    </Card>
  );
}
