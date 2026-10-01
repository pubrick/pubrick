"use client";

import {
  CONTENT_TYPES,
  type ContentReuseCreate,
  type ContentReuseSourcePreview,
  type ContentType,
  contentReuseCreateSchema,
  contentReuseResultSchema,
  contentReuseSourcePreviewSchema,
  MAX_BRIEF_LENGTH,
  PAID_GENERATION_CONSENT_VERSION,
} from "@pubrick/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { ContentReuseConfirmation } from "@/components/content-reuse-confirmation";
import {
  ContentReuseRecoveryBoundary,
  useReuseIdentity,
} from "@/components/content-reuse-recovery";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, api, errorMessage } from "@/lib/api";
import { retainPendingContentReuse, settlePendingContentReuse } from "@/lib/pending-content-reuse";
import { channelLabel } from "@/lib/platform";

type Channel = { id: string; name: string; platform: string };
type Attempt = { key: string; body: ContentReuseCreate };

/** Existing compose route, with a server-owned saved master instead of editable pasted material. */
export function SavedContentReuse({ sourceId }: { sourceId: string }) {
  return (
    <ContentReuseRecoveryBoundary operation="reuse" targetId={sourceId}>
      <SavedContentReuseForm sourceId={sourceId} />
    </ContentReuseRecoveryBoundary>
  );
}

function SavedContentReuseForm({ sourceId }: { sourceId: string }) {
  const identity = useReuseIdentity();
  const t = useTranslations("Reuse");
  const tc = useTranslations("ContentNew");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const router = useRouter();
  const [preview, setPreview] = useState<ContentReuseSourcePreview | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [contentType, setContentType] = useState<ContentType>("social_post");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [consent, setConsent] = useState(false);
  const [acceptedId, setAcceptedId] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const attempt = useRef<Attempt | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const showError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.noActiveOrg) {
        router.replace(`/${locale}/onboarding`);
        return;
      }
      setError(errorMessage(err, tc("genericError"), te));
    },
    [router, locale, tc, te],
  );
  const load = useCallback(async () => {
    if (attempt.current) return;
    setLoading(true);
    setError(null);
    try {
      const id = contentReuseSourcePreviewSchema.shape.id.parse(sourceId);
      const source = contentReuseSourcePreviewSchema.parse(
        await api(`/api/content/${id}/reuse-source`, { cache: "no-store" }),
      );
      const choices = await api<Channel[]>(`/api/channels?brandId=${source.brandId}`, {
        cache: "no-store",
      });
      setPreview(source);
      setChannels(choices);
      setStale(false);
      setConsent(false);
    } catch (err) {
      showError(err);
    } finally {
      setLoading(false);
    }
  }, [sourceId, showError]);
  useEffect(() => {
    void load();
  }, [load]);
  const chosenLabels = [...selected].map((id) => {
    const channel = channels.find((candidate) => candidate.id === id);
    return channel ? channelLabel(channel.platform, channel.name) : t("channelUnavailable");
  });
  const prepare = () => {
    if (uncertain && attempt.current) {
      setOpen(true);
      return;
    }
    if (!preview || stale || loading) return;
    if (!selected.size) {
      setError(tc("noChannelsSelected"));
      return;
    }
    if ([...selected].some((id) => !channels.some((channel) => channel.id === id))) {
      setError(te("channels_not_in_brand"));
      return;
    }
    setConsent(false);
    setError(null);
    setOpen(true);
  };
  const submit = async () => {
    if (!identity || !preview || !consent || inFlight.current) return;
    if (!attempt.current) {
      const parsed = contentReuseCreateSchema.safeParse({
        expectedSourceRevision: preview.bodyRevision,
        expectedSourceDigest: preview.digest,
        ...(title.trim() && { title }),
        ...(brief.trim() && { brief }),
        contentType,
        channelIds: [...selected],
        allowPaidGeneration: true,
        consentVersion: PAID_GENERATION_CONSENT_VERSION,
      });
      if (!parsed.success) {
        setError(te("invalid_request"));
        return;
      }
      attempt.current = { key: crypto.randomUUID(), body: parsed.data };
    }
    retainPendingContentReuse(identity, {
      operation: "reuse",
      targetId: sourceId,
      key: attempt.current.key,
      body: attempt.current.body,
    });
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const current = attempt.current;
      const result = contentReuseResultSchema.parse(
        await api(`/api/content/${sourceId}/reuse`, {
          method: "POST",
          headers: { "Idempotency-Key": current.key },
          body: JSON.stringify(current.body),
        }),
      );
      settlePendingContentReuse(identity, "reuse", sourceId, current.key);
      if (!mounted.current) return;
      setAcceptedId(result.id);
      setOpen(false);
      router.push(`/${locale}/content/runs/${result.id}`);
    } catch (err) {
      const unknown =
        uncertain ||
        !(err instanceof ApiError) ||
        err.status === 0 ||
        err.status === 401 ||
        err.status === 403 ||
        err.noActiveOrg ||
        err.status >= 500;
      setUncertain(unknown);
      if (unknown) setError(errorMessage(err, tc("genericError"), te));
      else showError(err);
      if (!unknown) {
        if (attempt.current)
          settlePendingContentReuse(identity, "reuse", sourceId, attempt.current.key);
        attempt.current = null;
        setConsent(false);
        setOpen(false);
        if (
          err instanceof ApiError &&
          (err.code === "reuse_source_changed" || err.code === "channels_not_in_brand")
        )
          setStale(true);
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <AppShell
      title={t("title")}
      primaryAction={
        <Button
          onClick={prepare}
          disabled={!identity || !preview || stale || loading || busy || acceptedId !== null}
        >
          {uncertain ? t("retry") : t("generate")}
        </Button>
      }
    >
      <p className="mb-4">
        <Link
          href={`/${locale}/content/${sourceId}`}
          className="text-sm text-fg-secondary hover:text-accent"
        >
          {t("backToSource")}
        </Link>
      </p>
      <Card className="max-w-2xl">
        {error && !open && (
          <p role="alert" className="mb-4 text-sm text-danger">
            {error}
          </p>
        )}
        {loading && (
          <p role="status" className="text-sm text-fg-secondary">
            {t("loading")}
          </p>
        )}
        {preview && (
          <>
            <h2 className="font-medium">{preview.title?.trim() ? preview.title : t("untitled")}</h2>
            <p className="mt-1 text-sm text-fg-secondary">
              {t("revision", { revision: preview.bodyRevision })}
            </p>
            <p className="mt-3 text-sm text-fg-secondary">{t("previewHint")}</p>
            <p
              data-testid="reuse-source-preview"
              className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-control border border-border p-3 text-sm"
            >
              {preview.material}
            </p>
          </>
        )}
        {stale && (
          <Button
            className="mt-4"
            variant="secondary"
            onClick={() => void load()}
            disabled={busy || loading}
          >
            {t("refresh")}
          </Button>
        )}
        {!preview && !loading && (
          <Button variant="secondary" onClick={() => void load()}>
            {t("retry")}
          </Button>
        )}
        <fieldset
          disabled={!preview || busy || loading || uncertain || acceptedId !== null}
          className="mt-5 flex flex-col gap-5"
        >
          <div>
            <p className="mb-2 text-sm font-medium text-fg-secondary">{tc("channels")}</p>
            <ul className="divide-y divide-border-soft rounded-control border border-border">
              {channels.map((channel) => (
                <li key={channel.id} className="px-3 py-2">
                  <label className="flex min-h-11 items-center gap-3 text-sm">
                    <input
                      type="checkbox"
                      checked={selected.has(channel.id)}
                      onChange={() =>
                        setSelected((prior) => {
                          const next = new Set(prior);
                          if (next.has(channel.id)) next.delete(channel.id);
                          else next.add(channel.id);
                          return next;
                        })
                      }
                    />
                    {channelLabel(channel.platform, channel.name)}
                  </label>
                </li>
              ))}
              {[...selected]
                .filter((id) => !channels.some((channel) => channel.id === id))
                .map((id) => (
                  <li key={id} className="px-3 py-2">
                    <label className="flex min-h-11 items-center gap-3 text-sm">
                      <input
                        type="checkbox"
                        checked
                        onChange={() =>
                          setSelected((prior) => {
                            const next = new Set(prior);
                            next.delete(id);
                            return next;
                          })
                        }
                      />
                      {t("channelUnavailable")}
                    </label>
                  </li>
                ))}
            </ul>
            {preview && !channels.length && (
              <p className="mt-2 text-sm">
                <Link
                  className="text-accent hover:underline"
                  href={`/${locale}/brands/${preview.brandId}#channels`}
                >
                  {tc("noChannels")}
                </Link>
              </p>
            )}
          </div>
          <Input
            id="reuse-title"
            label={tc("titleLabel")}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={300}
          />
          <Textarea
            id="reuse-brief"
            label={tc("briefLabel")}
            value={brief}
            onChange={(event) => setBrief(event.target.value)}
            maxLength={MAX_BRIEF_LENGTH}
            showCount
            rows={3}
          />
          <Select
            id="reuse-format"
            label={tc("contentTypeLabel")}
            value={contentType}
            onChange={(event) => setContentType(event.target.value as ContentType)}
          >
            {CONTENT_TYPES.map((format) => (
              <option key={format} value={format}>
                {tc(`contentType.${format}`)}
              </option>
            ))}
          </Select>
        </fieldset>
        {acceptedId && (
          <p className="mt-3 text-sm">
            <Link
              className="text-accent hover:underline"
              href={`/${locale}/content/runs/${acceptedId}`}
            >
              {t("openRun")}
            </Link>
          </p>
        )}
        {uncertain && (
          <p role="status" className="mt-3 text-sm text-fg-secondary">
            {t("uncertain")}
          </p>
        )}
      </Card>
      {preview && (
        <ContentReuseConfirmation
          open={open}
          onClose={() => {
            if (!busy) setOpen(false);
          }}
          onConfirm={() => void submit()}
          title={preview.title}
          revision={preview.bodyRevision}
          contentType={contentType}
          channels={chosenLabels}
          consent={consent}
          onConsent={setConsent}
          busy={busy}
          error={error}
          uncertain={uncertain}
          material={preview.material}
          brief={brief}
        />
      )}
    </AppShell>
  );
}
