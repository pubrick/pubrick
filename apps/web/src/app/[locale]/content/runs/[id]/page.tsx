"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, use, useCallback, useEffect, useState } from "react";
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
  type RunClaim,
  type RunDetail,
  type RunStepKey,
  runClaims,
  runEditorChanges,
  runFailureMessage,
  runStepStates,
} from "@/lib/runs";

/** Module-level so it is a stable `usePoll` dependency (see that hook's contract). */
const isRunFinished = (run: RunDetail) => isTerminalRunStatus(run.status);

/**
 * The lines a step produced, under that step's own heading.
 *
 * Shared by the two steps that produce something a human reads, because they
 * have the identical three-way problem and it must be answered the same way on
 * both: `null` says nothing at all (no checkpoint, a failed one, or stored
 * output this build cannot read — a step that never ran has the badge to speak
 * for it and this row is entitled to no other claim); `[]` says, in words, that
 * the step ran and produced nothing, which is a real and paid-for outcome that
 * silence would render indistinguishable from never running; and a list is the
 * list.
 *
 * Inline rather than behind a disclosure: this output is the thing the run was
 * bought for, and folding it away is how it came to be rendered nowhere. And
 * not an `EmptyState` either — that component is a verdict about a list with a
 * next action to teach, and "the step listed nothing" is a finding with no next
 * action, so it would have to invent one.
 */
function StepLines({ lines, empty, mark }: StepLinesProps) {
  if (lines === null) return null;
  if (lines.length === 0) {
    return <p className="mt-2 text-sm text-fg-tertiary">{empty}</p>;
  }
  return (
    <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-5">
      {lines.map((line, index) => (
        <li
          // biome-ignore lint/suspicious/noArrayIndexKey: a frozen checkpoint's list — never reordered, inserted into or edited
          key={index}
          className="text-sm text-fg-secondary"
        >
          {line.text}
          {line.marked && mark !== undefined && (
            <span className="ml-2 text-[13px] text-fg-tertiary">{mark}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

type StepLine = { text: string; marked: boolean };

/**
 * The two step outputs, each in the one shape `StepLines` renders — and each
 * carrying its `null` through unchanged, because `null` is an answer here
 * ("nothing to say") and not an absence to be mapped over.
 */
function claimLines(claims: RunClaim[] | null): StepLine[] | null {
  return claims === null ? null : claims.map((c) => ({ text: c.text, marked: c.needsCheck }));
}

function changeLines(changes: string[] | null): StepLine[] | null {
  return changes === null ? null : changes.map((text) => ({ text, marked: false }));
}
type StepLinesProps = {
  lines: StepLine[] | null;
  /** What to say when the step ran and produced an empty list. */
  empty: string;
  /** Suffix for a marked line. Only the claims have one. */
  mark?: string;
};

/** One labelled thing the run was asked for. Every block in the card is one. */
function RunField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-sm font-medium text-fg-secondary">{label}</p>
      {children}
    </div>
  );
}

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
  /**
   * The refusals' own namespace, and a second one on this screen rather than a
   * widening of `Runs`: `runFailureMessage` below already translates why a run
   * DIED, which is a different question from why the api refused to cancel it.
   * Cancel is the only write this screen makes, and every reason it can be
   * refused (the run finished, failed, or was already cancelled) is a sentence
   * only `errorMessage` can put in the reader's language.
   */
  const te = useTranslations("Errors");
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
      setActionError(errorMessage(err, t("genericError"), te));
    } finally {
      setCancelling(false);
    }
  }

  const error = actionError ?? (pollError ? errorMessage(pollError, t("genericError"), te) : null);
  // Our sentence for the run's failure code, in the reader's language. Never
  // the provider's own words: those are English, and they are where a
  // submitted API key gets quoted back at whoever is looking at this page.
  const failure = runFailureMessage(t, run?.errorCode ?? null);
  const draftHref = run?.contentItemId ? `/${locale}/content/${run.contentItemId}` : null;
  /**
   * A succeeded run always wrote a content item, and `content_item_id` is
   * ON DELETE SET NULL because the run outlives the draft it bought. So this
   * combination has exactly one cause, and naming it beats leaving a blank
   * where the link used to be.
   */
  const draftDeleted = run?.status === "succeeded" && run.contentItemId === null;
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

  /**
   * Which steps have something to show, and what it is called.
   *
   * A closed switch over `RunStepKey` rather than a lookup that silently
   * returns nothing: a sixth step added upstream arrives here as a decision to
   * make, not as output quietly dropped on the floor — the exact way the
   * fact-checker's list came to be paid for and rendered nowhere.
   *
   * `needsCheck` marks the claims the model judged a reader could reasonably
   * question. It is NOT a verdict on the claim and not the residue of a check:
   * nothing was checked, and the heading over the whole list says every one of
   * them is to be verified. The marker only says which ones to start with.
   */
  function detailFor(key: RunStepKey): React.ReactNode {
    if (run === null) return null;
    switch (key) {
      case "factcheck":
        return (
          <StepLines
            lines={claimLines(runClaims(run))}
            empty={t("claimsEmpty")}
            mark={t("claimNeedsCheck")}
          />
        );
      case "editor":
        return <StepLines lines={changeLines(runEditorChanges(run))} empty={t("changesEmpty")} />;
      // The other three steps produce the draft itself (or a per-channel copy
      // of it), and the draft belongs on the item screen where it can be
      // edited. A receipt is not a second, frozen copy of the post.
      default:
        return null;
    }
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

          {/*
            WHAT THE RUN WAS ASKED FOR, branched on `kind` — and the branch is
            not one the compiler asked for. Both arms of `RunInput` carry
            `text`, so an unbranched `{run.input.text}` type-checks against a
            source run and renders NOTHING for a paste with no brief: a labelled
            empty block on the screen whose only job is to say what happened.
            `material` is the field that does not compile without the narrowing,
            which means the compiler points at the new half and stays silent
            about the old one.
          */}
          <Card className="mb-6">
            <div className="flex flex-col gap-4">
              {run.input.kind === "source" && run.input.text === null ? (
                /*
                  Not an empty "Brief" block. A label with nothing under it reads
                  as "the person wrote nothing useful"; this line says what
                  actually happened — they wrote nothing and the draft came from
                  the material below.
                */
                <p className="text-sm text-fg-tertiary">{t("noBrief")}</p>
              ) : (
                <RunField label={t("briefLabel")}>
                  <p className="whitespace-pre-wrap text-sm text-fg">{run.input.text}</p>
                </RunField>
              )}

              {run.input.kind === "source" && (
                <>
                  {run.input.sourceUrl !== null && (
                    <RunField label={t("sourceLabel")}>
                      {/*
                        Attribution, and ONLY attribution: nothing here or on the
                        server ever fetches it, and it never reaches a model. It
                        is a link because the DTO refuses any scheme but
                        http/https — the reason `sourceUrl` constrains its
                        protocol rather than merely being a URL.
                      */}
                      <a
                        href={run.input.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="break-all text-sm text-accent hover:underline"
                      >
                        {run.input.sourceUrl}
                      </a>
                    </RunField>
                  )}
                  <RunField label={t("materialLabel")}>
                    <p className="whitespace-pre-wrap text-sm text-fg">{run.input.material}</p>
                  </RunField>
                </>
              )}
            </div>
          </Card>

          {/* A failed run produces no content item, so this sentence is the
              only place the failure is explained at all — collapsing it into a
              generic apology would delete it. */}
          {failure && (
            <p role="alert" className="mb-6 text-sm text-danger">
              {failure}
            </p>
          )}

          {/*
            Not an alert and not the danger color: the draft being deleted is
            something a person did on purpose, not a failure of this run. Five
            statuses exist and none of them is "a thing that used to be here".
          */}
          {draftDeleted && <p className="mb-6 text-sm text-fg-tertiary">{t("draftDeleted")}</p>}

          {/*
            Billed model calls the ledger refused to record. THREE values and
            three renderings, because collapsing any two of them is a lie
            about money: a count is a loss and is said as one, with where the
            org's figure is short; zero says nothing, because nothing was lost
            and a receipt that announced it on every run would teach readers
            to skip the line that matters; and NULL — a run from before the
            counter existed — is a statement of ignorance, not of a loss, so it
            is neither an alert nor silence. The worker counted this for a day
            before anything read it; this is where it is read.
          */}
          {run.unrecordedCalls !== null && run.unrecordedCalls > 0 && (
            <p role="alert" className="mb-6 text-sm text-danger">
              {t("unrecordedCalls", { count: run.unrecordedCalls })}
            </p>
          )}
          {run.unrecordedCalls === null && (
            <p className="mb-6 text-sm text-fg-tertiary">{t("unrecordedUnknown")}</p>
          )}

          <h2 className="mb-3 text-lg font-semibold text-fg">{t("stepsTitle")}</h2>
          <Card padded={false}>
            <ul className="px-4">
              {runStepStates(run).map((step) => (
                <li key={step.key} className="border-b border-border-soft py-3 last:border-b-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
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
                  </div>
                  {/*
                    The step's own output, under the step's own heading — which
                    for the fact-checker is the heading its prompt promises the
                    model the list will appear under (`CLAIMS_TO_VERIFY_LABEL`,
                    pinned to `step.factcheck` by `factcheck-label.test.ts`).
                    A separate section further down would put that phrase on the
                    screen twice.
                  */}
                  {detailFor(step.key)}
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
    </AppShell>
  );
}
