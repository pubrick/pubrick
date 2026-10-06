"use client";

import {
  type MetaPreparationSnapshot,
  type MetaPreparationsPage,
  metaPreparationDiscardedSchema,
  metaPreparationDiscardSchema,
  metaPreparationsPageSchema,
} from "@pubrick/shared";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePoll } from "@/hooks/use-poll";
import { ApiError, api, errorMessage } from "@/lib/api";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Modal } from "./ui/modal";
import { StatusBadge } from "./ui/status-badge";

const empty: MetaPreparationsPage = { stages: [], nextCursor: null };
function terminal(page: MetaPreparationsPage) {
  return !page.stages.some((stage) =>
    ["preparation_intent", "waiting", "final_intent"].includes(stage.phase),
  );
}
function identity(stage: MetaPreparationSnapshot) {
  return `${stage.stageId}/${stage.attempt}/${stage.inputHash}/${stage.phase}/${stage.recoverable}`;
}

/** Independent delivery evidence: refreshes never replace the composer's unsaved text. */
export function MetaPreparations(props: { itemId: string; canRecover: boolean }) {
  return <MetaPreparationsContent key={props.itemId} {...props} />;
}

function MetaPreparationsContent({ itemId, canRecover }: { itemId: string; canRecover: boolean }) {
  const t = useTranslations("MetaPreparations");
  const te = useTranslations("Errors");
  const [needsReload, setNeedsReload] = useState(false);
  const fetcher = useCallback(
    async () =>
      needsReload
        ? empty
        : metaPreparationsPageSchema.parse(
            await api(`/api/content/${itemId}/meta-preparations`, { cache: "no-store" }),
          ),
    [itemId, needsReload],
  );
  const {
    data,
    error: readError,
    refresh,
    mutate,
  } = usePoll(fetcher, terminal, { intervalMs: 5000 });
  const [laterPages, setLaterPages] = useState<MetaPreparationsPage[]>([]);
  const [selected, setSelected] = useState<MetaPreparationSnapshot | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const epoch = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(
    () => () => {
      epoch.current += 1;
    },
    [],
  );
  const first = needsReload ? null : data;
  const stages = first
    ? [...first.stages, ...laterPages.flatMap((page) => page.stages)].filter(
        (stage, index, all) =>
          all.findIndex((candidate) => candidate.stageId === stage.stageId) === index,
      )
    : [];
  const cursor = laterPages.length
    ? laterPages[laterPages.length - 1]?.nextCursor
    : first?.nextCursor;
  const shown = selected ? stages.find((stage) => stage.stageId === selected.stageId) : undefined;
  const selectionCurrent = Boolean(
    selected &&
      shown &&
      identity(shown) === identity(selected) &&
      canRecover &&
      !needsReload &&
      !readError,
  );
  useEffect(() => {
    if (selected && !selectionCurrent && !busy) {
      setSelected(null);
      setAcknowledged(false);
    }
  }, [selected, selectionCurrent, busy]);

  async function reload() {
    if (busyRef.current) return;
    epoch.current += 1;
    setSelected(null);
    setAcknowledged(false);
    setLaterPages([]);
    setError(null);
    if (needsReload) setNeedsReload(false);
    else await refresh();
  }
  async function loadMore() {
    if (!cursor || busyRef.current || needsReload || readError) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const request = epoch.current;
    try {
      const page = metaPreparationsPageSchema.parse(
        await api(`/api/content/${itemId}/meta-preparations?cursor=${encodeURIComponent(cursor)}`, {
          cache: "no-store",
        }),
      );
      if (request === epoch.current) setLaterPages((pages) => [...pages, page]);
    } catch (caught) {
      if (request === epoch.current) {
        setError(errorMessage(caught, t("failed"), te));
        if (caught instanceof ApiError && [401, 403, 404].includes(caught.status)) {
          setNeedsReload(true);
          setLaterPages([]);
          mutate(() => null);
        }
      }
    } finally {
      busyRef.current = false;
      if (request === epoch.current) setBusy(false);
    }
  }
  async function discard() {
    if (!selected || !acknowledged || !selectionCurrent || busyRef.current) return;
    const snapshot = selected;
    const request = ++epoch.current;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    // Invalidates a progress read that left before this confirmed mutation.
    mutate((previous) => previous);
    try {
      const result = metaPreparationDiscardedSchema.parse(
        await api(`/api/content/${itemId}/meta-preparations/${snapshot.stageId}/discard`, {
          method: "POST",
          body: JSON.stringify(
            metaPreparationDiscardSchema.parse({
              expectedAttempt: snapshot.attempt,
              expectedInputHash: snapshot.inputHash,
              acknowledgeNonpublicPreparation: true,
            }),
          ),
        }),
      );
      if (result.stageId !== snapshot.stageId) throw new Error("Unexpected preparation identity");
      if (request !== epoch.current) return;
      const cancelled = (stage: MetaPreparationSnapshot) =>
        stage.stageId === snapshot.stageId
          ? { ...stage, phase: "cancelled" as const, recoverable: false }
          : stage;
      mutate((previous) =>
        previous ? { ...previous, stages: previous.stages.map(cancelled) } : previous,
      );
      setLaterPages((pages) =>
        pages.map((page) => ({ ...page, stages: page.stages.map(cancelled) })),
      );
      setSelected(null);
      setAcknowledged(false);
      setNotice(t("discarded"));
      await refresh();
    } catch (caught) {
      if (request === epoch.current) {
        // An unknown/stale POST result is not permission to replay the old confirmation.
        setError(errorMessage(caught, t("failed"), te));
        setNeedsReload(true);
        setLaterPages([]);
        setSelected(null);
        setAcknowledged(false);
        mutate(() => null);
      }
    } finally {
      busyRef.current = false;
      if (request === epoch.current) setBusy(false);
    }
  }
  if (!first && !readError && !error && !notice && !needsReload) return null;
  if (first?.stages.length === 0 && !readError && !error && !notice && !needsReload) return null;
  return (
    <Card className="mb-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold">{t("title")}</h2>
        <Button
          className="min-h-11"
          variant="secondary"
          disabled={busy}
          onClick={() => void reload()}
        >
          {t("reload")}
        </Button>
      </div>
      <p className="mt-2 text-sm text-fg-secondary">{t("help")}</p>
      {notice && (
        <p role="status" className="mt-3 text-sm text-fg">
          {notice}
        </p>
      )}
      {Boolean(error || readError) && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error ?? errorMessage(readError, notice ? t("refreshFailed") : t("failed"), te)}
        </p>
      )}
      {needsReload && <p className="mt-2 text-sm text-fg-secondary">{t("reloadRequired")}</p>}
      {!needsReload && !readError && stages.length > 0 && (
        <ul className="mt-4 space-y-4">
          {stages.map((stage) => (
            <li key={stage.stageId} className="rounded-control border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="font-medium">{stage.channelName ?? t("removedChannel")}</span>
                <StatusBadge
                  status={
                    stage.phase === "cancelled"
                      ? "draft"
                      : stage.phase === "published"
                        ? "published"
                        : stage.phase === "failed"
                          ? "failed"
                          : "review"
                  }
                >
                  {t(`phases.${stage.phase}`)}
                </StatusBadge>
              </div>
              <p className="mt-2 text-sm text-fg-secondary">
                {t("attempt", { attempt: stage.attempt })}
              </p>
              {stage.containerId && (
                <p className="mt-1 break-all text-sm text-fg-secondary">
                  {t("container", { id: stage.containerId })}
                </p>
              )}
              <p className="mt-1 break-all text-xs text-fg-tertiary">
                {t("record", { id: stage.stageId })}
              </p>
              {stage.reason && (
                <p className="mt-2 text-sm text-fg-secondary">{t(`reasons.${stage.reason}`)}</p>
              )}
              {stage.phase === "preparation_unknown" && (
                <>
                  <p className="mt-2 text-sm text-fg-secondary">
                    {stage.recoverable ? t("unknownHelp") : t("blocked")}
                  </p>
                  {canRecover && stage.recoverable && (
                    <Button
                      className="mt-3 min-h-11"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => {
                        setSelected(stage);
                        setAcknowledged(false);
                        setError(null);
                        setNotice(null);
                      }}
                    >
                      {t("discard")}
                    </Button>
                  )}
                </>
              )}
              {["final_unknown", "published_without_receipt"].includes(stage.phase) && (
                <p className="mt-2 text-sm text-fg-secondary">{t("finalHelp")}</p>
              )}
            </li>
          ))}
        </ul>
      )}
      {cursor && !needsReload && !readError && (
        <Button
          className="mt-4 min-h-11"
          variant="secondary"
          disabled={busy}
          onClick={() => void loadMore()}
        >
          {t("loadMore")}
        </Button>
      )}
      <Modal
        open={Boolean(selected)}
        title={t("confirmTitle")}
        onClose={() => {
          if (!busy) {
            setSelected(null);
            setAcknowledged(false);
          }
        }}
        footer={
          <>
            <Button
              className="min-h-11"
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setSelected(null);
                setAcknowledged(false);
              }}
            >
              {t("cancel")}
            </Button>
            <Button
              className="min-h-11"
              variant="danger"
              disabled={busy || !acknowledged || !selectionCurrent}
              onClick={() => void discard()}
            >
              {busy ? t("working") : t("discard")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-fg-secondary">{t("confirmHelp")}</p>
        {selected && (
          <p className="mt-3 break-all text-sm">
            {t("confirmRecord", {
              channel: selected.channelName ?? t("removedChannel"),
              attempt: selected.attempt,
              id: selected.stageId,
            })}
          </p>
        )}
        <label className="mt-4 flex min-h-11 cursor-pointer items-start gap-3 text-sm">
          <input
            className="mt-1"
            type="checkbox"
            checked={acknowledged}
            disabled={busy}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          <span>{t("acknowledge")}</span>
        </label>
      </Modal>
    </Card>
  );
}
