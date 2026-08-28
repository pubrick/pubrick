"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { use, useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
import { usePoll } from "@/hooks/use-poll";
import { ApiError, api, errorMessage } from "@/lib/api";
import {
  isTerminalRunStatus,
  RUN_BADGE_STATUS,
  RUN_STEP_BADGE_STATUS,
  type RunDetail,
  runStepStates,
} from "@/lib/runs";

/** Module-level so it is a stable `usePoll` dependency (see that hook's contract). */
const isRunFinished = (run: RunDetail) => isTerminalRunStatus(run.status);

/**
 * The generation receipt: five steps as a live checklist, the error when the
 * run failed, and a "Draft ready" link when it worked.
 *
 * The link is a link, and this screen NEVER navigates on its own. Auto-forwarding
 * to the finished draft the moment a run succeeds would stamp
 * `first_opened_at` — the publish gate's "a human read this" signal — on the
 * exact flow this increment exists to deliver, with no human having read
 * anything. The promise would still be enforced server-side and would still be
 * worthless. `page.test.tsx` fails if a redirect is ever added here.
 */
export default function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations("Runs");
  const locale = useLocale();
  const router = useRouter();

  // `no-store` for the same reason the queue's poll sets it: a cached body is
  // the one thing a poll must never be answered with.
  const fetchRun = useCallback(
    () => api<RunDetail>(`/api/runs/${id}`, { cache: "no-store" }),
    [id],
  );
  const { data: run, error: pollError, refresh } = usePoll(fetchRun, isRunFinished);

  const [actionError, setActionError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  // An account with no active organization belongs in onboarding, not on a
  // receipt it can never load — the same redirect every other screen makes,
  // moved into an effect because the failure arrives from the poll rather than
  // from a call this component awaited.
  useEffect(() => {
    if (pollError instanceof ApiError && pollError.noActiveOrg) {
      router.replace(`/${locale}/onboarding`);
    }
  }, [pollError, router, locale]);

  async function cancel() {
    setActionError(null);
    setCancelling(true);
    try {
      await api(`/api/runs/${id}/cancel`, { method: "POST" });
      await refresh();
    } catch (err) {
      setActionError(errorMessage(err, t("genericError")));
    } finally {
      setCancelling(false);
    }
  }

  const error = actionError ?? (pollError ? errorMessage(pollError, t("genericError")) : null);
  const draftHref = run?.contentItemId ? `/${locale}/content/${run.contentItemId}` : null;
  const inFlight = run !== null && !isTerminalRunStatus(run.status);

  // One primary action, and only one: the finished draft while there is one to
  // open, Cancel while the run is still spending money, nothing once it has
  // stopped (Try again and Dismiss live on the queue strip — one place each).
  let primaryAction: React.ReactNode;
  if (run?.status === "succeeded" && draftHref) {
    primaryAction = (
      <Link href={draftHref} className={buttonClasses()}>
        {t("draftReady")}
      </Link>
    );
  } else if (inFlight) {
    primaryAction = (
      <Button variant="danger" onClick={cancel} disabled={cancelling}>
        {t("cancel")}
      </Button>
    );
  }

  return (
    <AppShell title={t("title")} primaryAction={primaryAction}>
      <p className="mb-3">
        <Link href={`/${locale}/content`} className="text-sm text-fg-secondary hover:text-accent">
          {t("backToQueue")}
        </Link>
      </p>

      {error && (
        <p role="alert" className="mb-4 text-sm text-danger">
          {error}
        </p>
      )}

      {run && (
        <>
          <p className="mb-4">
            <StatusBadge status={RUN_BADGE_STATUS[run.status]}>
              {t(`status.${run.status}`)}
            </StatusBadge>
          </p>

          <Card className="mb-6">
            <p className="mb-1 text-sm font-medium text-fg-secondary">{t("briefLabel")}</p>
            <p className="whitespace-pre-wrap text-sm text-fg">{run.input.text}</p>
          </Card>

          {/* The run's own error, verbatim. A failed run produces no content
              item, so this sentence is the only place the failure is explained
              at all — collapsing it into a generic apology would delete it. */}
          {run.error && (
            <p role="alert" className="mb-6 text-sm text-danger">
              {run.error}
            </p>
          )}

          <h2 className="mb-3 text-lg font-semibold text-fg">{t("stepsTitle")}</h2>
          <Card padded={false}>
            <ul className="px-4">
              {runStepStates(run).map((step) => (
                <li
                  key={step.key}
                  className="flex flex-wrap items-center justify-between gap-2 border-b border-border-soft py-3 last:border-b-0"
                >
                  <span className="text-sm text-fg">
                    {t(`step.${step.key}`)}
                    {step.total > 1 && (
                      <span className="ml-2 text-[13px] text-fg-tertiary">
                        {t("stepProgress", { done: step.done, total: step.total })}
                      </span>
                    )}
                  </span>
                  <StatusBadge status={RUN_STEP_BADGE_STATUS[step.state]}>
                    {t(`stepState.${step.state}`)}
                  </StatusBadge>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
    </AppShell>
  );
}
