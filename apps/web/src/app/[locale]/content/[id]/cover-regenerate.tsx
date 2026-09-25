"use client";

import type { MediaAssetDto, MediaCoverRegenerateResult } from "@pubrick/shared";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage } from "@/lib/api";

export function CoverRegenerate({
  itemId,
  title,
  coverMediaId,
  onChanged,
  onOpenLibrary,
}: {
  itemId: string;
  title: string | null;
  coverMediaId: string | null;
  onChanged: () => void | Promise<void>;
  onOpenLibrary: () => void;
}) {
  const t = useTranslations("Media");
  const te = useTranslations("Errors");
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const prefillToken = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MediaCoverRegenerateResult | null>(null);

  useEffect(() => {
    void api<{ provider: string }[]>("/api/ai-credentials")
      .then((keys) => setHasKey(keys.some((key) => key.provider === "google")))
      .catch(() => setHasKey(false));
  }, []);

  const close = useCallback(() => {
    if (busyRef.current) return;
    prefillToken.current += 1;
    setOpen(false);
  }, []);

  async function show() {
    const token = ++prefillToken.current;
    setResult(null);
    setError(null);
    setPrompt(t("coverPromptSuggestion", { title: title?.trim() || t("coverUntitled") }));
    setOpen(true);
    if (!coverMediaId) return;
    try {
      const asset = await api<MediaAssetDto>(`/api/media/${coverMediaId}`);
      const match = /^AI (?:image|variation):\s*(.+)$/i.exec(asset.name);
      if (token === prefillToken.current && match?.[1]) setPrompt(match[1]);
    } catch {
      // Older or removed assets have no prompt; the editable suggestion remains.
    }
  }

  async function regenerate() {
    if (busyRef.current || hasKey !== true || prompt.trim().length < 8) return;
    prefillToken.current += 1;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const generated = await api<MediaCoverRegenerateResult>(
        `/api/media/posts/${itemId}/cover/regenerate`,
        {
          method: "POST",
          body: JSON.stringify({
            prompt: prompt.trim(),
            expectedCoverMediaId: coverMediaId,
          }),
        },
      );
      setResult(generated);
      if (generated.attached) await onChanged();
    } catch (cause) {
      setError(errorMessage(cause, t("coverRegenerateFailed"), te));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="secondary" onClick={() => void show()}>
        {t("regenerateCover")}
      </Button>
      <Modal
        open={open}
        onClose={close}
        title={t("regenerateCover")}
        footer={
          result ? (
            <>
              {!result.attached && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    close();
                    onOpenLibrary();
                  }}
                >
                  {t("openLibrary")}
                </Button>
              )}
              <Button onClick={close}>{t("done")}</Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={close} disabled={busy}>
                {t("cancelVariation")}
              </Button>
              <Button
                disabled={busy || hasKey !== true || prompt.trim().length < 8}
                onClick={() => void regenerate()}
              >
                {busy ? t("generating") : t("regenerateCover")}
              </Button>
            </>
          )
        }
      >
        {result ? (
          <div className="space-y-3">
            {/* Authenticated, tenant-scoped file endpoint. */}
            {/* biome-ignore lint/performance/noImgElement: signed-in file endpoint */}
            <img
              src={`/api/media/${result.asset.id}/file`}
              alt={t("newCover")}
              className="max-h-72 w-full rounded-control object-contain"
            />
            <p role="status" className="text-sm text-fg-secondary">
              {result.attached
                ? t("coverAttached")
                : result.reason === "media_cover_changed"
                  ? t("coverConflict")
                  : t("coverUnattached")}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-fg-secondary">{t("coverRegenerateHint")}</p>
            {hasKey === false && (
              <p role="alert" className="text-sm text-danger">
                {t("coverNeedsGoogle")}
              </p>
            )}
            <Textarea
              label={t("prompt")}
              value={prompt}
              maxLength={2000}
              disabled={busy}
              onChange={(event) => {
                prefillToken.current += 1;
                setPrompt(event.target.value);
              }}
            />
            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}
