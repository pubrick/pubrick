"use client";

import {
  contentReuseResultSchema,
  contentReuseRetrySchema,
  PAID_GENERATION_CONSENT_VERSION,
} from "@pubrick/shared";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { ContentReuseConfirmation } from "@/components/content-reuse-confirmation";
import { useReuseIdentity } from "@/components/content-reuse-recovery";
import { Button } from "@/components/ui/button";
import { ApiError, api, errorMessage } from "@/lib/api";
import { retainPendingContentReuse, settlePendingContentReuse } from "@/lib/pending-content-reuse";
import { channelLabel } from "@/lib/platform";
import type { RunDetail } from "@/lib/runs";

export function ContentReuseRetryAction({ run }: { run: RunDetail }) {
  const identity = useReuseIdentity();
  const t = useTranslations("Reuse");
  const tr = useTranslations("Runs");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [channels, setChannels] = useState<string[]>([]);
  const [complete, setComplete] = useState(false);
  const [snapshot, setSnapshot] = useState<{
    source: NonNullable<RunDetail["internalSource"]>;
    input: Exclude<RunDetail["input"], { kind: "redacted" }>;
  } | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const key = useRef<string | null>(null);
  const source = run.internalSource;
  const input = run.input;
  if (!source && !snapshot) return null;
  if (!uncertain && (input.kind === "redacted" || source?.state === "redacted"))
    return <p className="mb-4 text-sm text-fg-secondary">{t("retryRedacted")}</p>;
  const prepare = async () => {
    if (busy || complete || inFlight.current) return;
    if (uncertain) {
      setOpen(true);
      return;
    }
    if (!source || input.kind === "redacted" || source.state === "redacted") return;
    setError(null);
    setBusy(true);
    inFlight.current = true;
    try {
      const choices = await api<{ id: string; platform: string; name: string }[]>(
        `/api/channels?brandId=${run.brandId}`,
        { cache: "no-store" },
      );
      if (input.channelIds.some((id) => !choices.some((choice) => choice.id === id))) {
        setError(t("retryChannelUnavailable"));
        return;
      }
      setChannels(
        input.channelIds.map((id) => {
          const channel = choices.find((choice) => choice.id === id);
          return channel
            ? channelLabel(channel.platform, channel.name)
            : t("retryChannelUnavailable");
        }),
      );
      setSnapshot({ source, input });
      setConsent(false);
      setOpen(true);
    } catch (err) {
      setError(errorMessage(err, tr("genericError"), te));
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  };
  const submit = async () => {
    if (!identity || !consent || inFlight.current || complete) return;
    key.current ??= crypto.randomUUID();
    const body = contentReuseRetrySchema.parse({
      allowPaidGeneration: true,
      consentVersion: PAID_GENERATION_CONSENT_VERSION,
    });
    retainPendingContentReuse(identity, {
      operation: "reuse-retry",
      targetId: run.id,
      key: key.current,
      body,
    });
    setBusy(true);
    setError(null);
    inFlight.current = true;
    try {
      const result = contentReuseResultSchema.parse(
        await api(`/api/runs/${run.id}/retry`, {
          method: "POST",
          headers: { "Idempotency-Key": key.current },
          body: JSON.stringify(body),
        }),
      );
      settlePendingContentReuse(identity, "reuse-retry", run.id, key.current);
      if (!mounted.current) return;
      setComplete(true);
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
      setError(errorMessage(err, tr("genericError"), te));
      if (!unknown) {
        settlePendingContentReuse(identity, "reuse-retry", run.id, key.current);
        key.current = null;
        setOpen(false);
        setConsent(false);
      }
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  };
  const confirmedSource = snapshot?.source;
  const confirmedInput = snapshot?.input;
  const sourceHidden = source?.state !== "available" || input.kind === "redacted";
  return (
    <div className="mb-6">
      <Button
        variant="secondary"
        disabled={!identity || busy || complete}
        onClick={() => void prepare()}
      >
        {t("retry")}
      </Button>
      {error && !open && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}
      {uncertain && (
        <p role="status" className="mt-3 text-sm text-fg-secondary">
          {t("uncertain")}
        </p>
      )}
      {confirmedSource && confirmedInput && (
        <ContentReuseConfirmation
          open={open}
          onClose={() => {
            if (!busy) setOpen(false);
          }}
          onConfirm={() => void submit()}
          title={
            !sourceHidden && confirmedSource.state === "available" ? confirmedSource.title : null
          }
          revision={confirmedSource.sourceRevision}
          contentType={confirmedInput.contentType ?? "social_post"}
          channels={channels}
          consent={consent}
          onConsent={setConsent}
          busy={busy}
          uncertain={uncertain}
          error={error}
          sourceUnavailable={sourceHidden}
          material={
            !sourceHidden && confirmedInput.kind === "source" ? confirmedInput.material : undefined
          }
          brief={input.kind !== "redacted" ? confirmedInput.text : undefined}
        />
      )}
    </div>
  );
}
