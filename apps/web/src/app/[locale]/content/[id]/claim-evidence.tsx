"use client";

import {
  type AcceptedClaimCorrectionDto,
  type AcceptedClaimCorrectionListDto,
  type ClaimCorrectionProposalDto,
  type ClaimReviewDto,
  claimCorrectionRequestSchema,
  claimReviewStartSchema,
} from "@pubrick/shared";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { Advanced } from "@/components/ui/advanced";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, api, apiVoid, errorMessage } from "@/lib/api";
import { isHttpUrl } from "@/lib/external-url";

type Props = {
  itemId: string;
  savedBody: string;
  draftBody: string;
  editable: boolean;
  canDecide?: boolean;
  aiDraftEligible?: boolean;
  hasRichFormatting?: boolean;
  unsavedFormatting?: boolean;
  onAccepted?: (body: string) => Promise<void>;
};

export function ClaimEvidence({
  itemId,
  savedBody,
  draftBody,
  editable,
  canDecide = true,
  aiDraftEligible = true,
  hasRichFormatting = false,
  unsavedFormatting = false,
  onAccepted,
}: Props) {
  const t = useTranslations("ClaimEvidence");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const [review, setReview] = useState<ClaimReviewDto | null | undefined>(undefined);
  const [proposal, setProposal] = useState<ClaimCorrectionProposalDto | null | undefined>(
    undefined,
  );
  const [busy, setBusy] = useState(false);
  const [correctionBusy, setCorrectionBusy] = useState<"propose" | "accept" | "discard" | null>(
    null,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [proposalError, setProposalError] = useState<string | null>(null);
  const [missingKey, setMissingKey] = useState<"search" | "ai" | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyRows, setHistoryRows] = useState<AcceptedClaimCorrectionDto[]>([]);
  const [historyNext, setHistoryNext] = useState<string | null>(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const loadGeneration = useRef(0);
  const proposalGeneration = useRef(0);
  const historyGeneration = useRef(0);
  const historyItemId = useRef(itemId);
  const proposalHeading = useRef<HTMLHeadingElement>(null);
  const focusProposal = useRef(false);
  const endpoint = `/api/content/${itemId}/claim-review`;
  const correctionEndpoint = `/api/content/${itemId}/claim-correction`;
  const historyEndpoint = `/api/content/${itemId}/claim-corrections`;
  const hasUnsavedText = draftBody !== savedBody || unsavedFormatting;

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    try {
      const result = await api<ClaimReviewDto | null>(endpoint);
      if (generation !== loadGeneration.current) return;
      setReview(result);
      setError(null);
    } catch (err) {
      if (generation !== loadGeneration.current) return;
      setError(errorMessage(err, t("genericError"), te));
    }
  }, [endpoint, t, te]);

  const loadProposal = useCallback(async () => {
    const generation = ++proposalGeneration.current;
    try {
      const result = await api<ClaimCorrectionProposalDto | null>(correctionEndpoint);
      if (generation !== proposalGeneration.current) return;
      setProposal(result);
      setProposalError(null);
    } catch (err) {
      if (generation !== proposalGeneration.current) return;
      setProposalError(errorMessage(err, t("proposalError"), te));
    }
  }, [correctionEndpoint, t, te]);

  const loadHistory = useCallback(
    async (cursor?: string) => {
      const generation = ++historyGeneration.current;
      setHistoryLoading(true);
      setHistoryError(null);
      try {
        const page = await api<AcceptedClaimCorrectionListDto>(
          `${historyEndpoint}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        if (generation !== historyGeneration.current) return;
        setHistoryRows((previous) => (cursor ? [...previous, ...page.rows] : page.rows));
        setHistoryNext(page.nextCursor);
      } catch (err) {
        if (generation !== historyGeneration.current) return;
        setHistoryError(errorMessage(err, t("historyError"), te));
      } finally {
        if (generation === historyGeneration.current) {
          setHistoryLoaded(true);
          setHistoryLoading(false);
        }
      }
    },
    [historyEndpoint, t, te],
  );

  useEffect(() => {
    if (historyItemId.current === itemId) return;
    historyItemId.current = itemId;
    historyGeneration.current += 1;
    setHistoryRows([]);
    setHistoryNext(null);
    setHistoryLoaded(false);
    setHistoryLoading(false);
    setHistoryError(null);
  }, [itemId]);

  // The server computes staleness against the persisted body, so saving an edit
  // must refresh even if the endpoint and load callback have not changed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: savedBody is a deliberate refresh trigger.
  useEffect(() => {
    setReview(undefined);
    setProposal(undefined);
    void load();
    void loadProposal();
  }, [load, loadProposal, savedBody]);

  useEffect(() => {
    if (!proposal || !focusProposal.current) return;
    focusProposal.current = false;
    proposalHeading.current?.focus();
  }, [proposal]);

  useEffect(() => {
    if (!historyOpen || historyLoaded || historyLoading) return;
    void loadHistory();
  }, [historyOpen, historyLoaded, historyLoading, loadHistory]);

  useEffect(() => {
    if (review?.status !== "queued" && review?.status !== "running") return;
    const timer = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(timer);
  }, [review?.status, load]);

  async function start() {
    if (busy || hasUnsavedText || !editable || !canDecide) return;
    setBusy(true);
    setError(null);
    setMissingKey(null);
    loadGeneration.current += 1;
    try {
      const body = claimReviewStartSchema.parse({ expectedBody: savedBody });
      await api<ClaimReviewDto>(endpoint, { method: "POST", body: JSON.stringify(body) });
      // A saved edit may have completed while POST was in flight. Re-read the
      // current article's review instead of trusting the old POST snapshot.
      await load();
      await loadProposal();
    } catch (err) {
      if (err instanceof ApiError && err.code === "claim_review_no_search_key") {
        setError(t("missingSearchKey"));
        setMissingKey("search");
      } else if (err instanceof ApiError && err.code === "claim_review_no_ai_key") {
        setError(t("missingAiKey"));
        setMissingKey("ai");
      } else {
        setError(errorMessage(err, t("genericError"), te));
      }
    } finally {
      setBusy(false);
    }
  }

  async function propose(claimIndex: number) {
    if (
      correctionBusy ||
      !editable ||
      !aiDraftEligible ||
      hasUnsavedText ||
      review?.status !== "ready" ||
      review.stale ||
      (proposal !== null &&
        (proposal === undefined ||
          proposalStale ||
          proposal.reviewId !== review.id ||
          proposal.claimIndex !== claimIndex))
    )
      return;
    const claim = review.claims[claimIndex];
    if (
      claim?.outcome !== "evidence_conflicts" ||
      !claim.evidence.some((source) => isHttpUrl(source.url))
    )
      return;
    setCorrectionBusy("propose");
    setProposalError(null);
    setNotice(null);
    proposalGeneration.current += 1;
    try {
      const request = claimCorrectionRequestSchema.parse({
        expectedBody: savedBody,
        reviewId: review.id,
        claimIndex,
      });
      const next = await api<ClaimCorrectionProposalDto>(correctionEndpoint, {
        method: "POST",
        body: JSON.stringify(request),
      });
      setProposal(next);
      setNotice(t("proposalReady"));
      focusProposal.current = true;
    } catch (err) {
      setProposalError(errorMessage(err, t("proposalError"), te));
    } finally {
      setCorrectionBusy(null);
    }
  }

  async function accept() {
    if (
      !proposal ||
      correctionBusy ||
      !canDecide ||
      !editable ||
      !aiDraftEligible ||
      hasUnsavedText ||
      proposalStale
    )
      return;
    setCorrectionBusy("accept");
    setProposalError(null);
    setNotice(null);
    proposalGeneration.current += 1;
    try {
      const updated = await api<{ body: string }>(`${correctionEndpoint}/${proposal.id}/accept`, {
        method: "POST",
      });
      setProposal(null);
      setNotice(t("accepted"));
      historyGeneration.current += 1;
      setHistoryRows([]);
      setHistoryNext(null);
      setHistoryLoaded(false);
      setHistoryLoading(false);
      await onAccepted?.(updated.body);
      await load();
    } catch (err) {
      setProposalError(errorMessage(err, t("proposalError"), te));
    } finally {
      setCorrectionBusy(null);
    }
  }

  async function discard() {
    if (!proposal || correctionBusy || !canDecide) return;
    setCorrectionBusy("discard");
    setProposalError(null);
    setNotice(null);
    proposalGeneration.current += 1;
    try {
      await apiVoid(`${correctionEndpoint}/${proposal.id}`, { method: "DELETE" });
      setProposal(null);
      setNotice(t("discarded"));
    } catch (err) {
      if (err instanceof ApiError && err.code === "claim_correction_not_found") {
        setProposal(null);
        setNotice(t("discarded"));
      } else {
        setProposalError(errorMessage(err, t("proposalError"), te));
      }
    } finally {
      setCorrectionBusy(null);
    }
  }

  const stale = review?.stale || hasUnsavedText;
  const active = !stale && (review?.status === "queued" || review?.status === "running");
  const proposalClaim =
    proposal && review?.status === "ready" && review.id === proposal.reviewId
      ? review.claims[proposal.claimIndex]
      : null;
  const proposalStale =
    proposal !== null &&
    proposal !== undefined &&
    (proposal.sourceBody !== savedBody ||
      review?.status !== "ready" ||
      review.stale ||
      proposalClaim?.outcome !== "evidence_conflicts" ||
      proposalClaim?.claim !== proposal.claim);

  function proposalView() {
    if (!proposal) return null;
    return (
      <section
        className="mt-3 rounded-control border border-border-soft p-4"
        aria-label={t("proposalTitle")}
      >
        <h3
          ref={proposalHeading}
          tabIndex={-1}
          className="text-sm font-semibold text-fg focus:outline-none"
        >
          {t("proposalTitle")}
        </h3>
        <p className="mt-1 text-sm text-fg-secondary">{t("proposalHint")}</p>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div>
            <h4 className="text-sm font-medium text-fg">{t("before")}</h4>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm text-fg-secondary">
              {proposal.claim}
            </p>
          </div>
          <div>
            <h4 className="text-sm font-medium text-fg">{t("after")}</h4>
            <p className="mt-1 whitespace-pre-wrap break-words text-sm text-fg">
              {proposal.replacement}
            </p>
          </div>
        </div>
        <p className="mt-3 text-sm text-fg-secondary">{proposal.reason}</p>
        {hasRichFormatting && (
          <p className="mt-3 text-sm text-fg-secondary">{t("formattingReset")}</p>
        )}
        {proposal.evidence.length > 0 && (
          <div className="mt-3">
            <p className="text-sm font-medium text-fg">{t("sourceResults")}</p>
            <ul className="mt-2 space-y-2">
              {proposal.evidence.map((source) =>
                isHttpUrl(source.url) ? (
                  <li key={`${source.url}:${source.snippet}`} className="text-sm">
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-accent underline"
                    >
                      {source.title || source.url}
                    </a>
                    <p className="mt-1 text-fg-secondary">{source.snippet}</p>
                  </li>
                ) : null,
              )}
            </ul>
          </div>
        )}
        {proposalStale && <p className="mt-3 text-sm text-danger">{t("proposalStale")}</p>}
        {hasUnsavedText && <p className="mt-3 text-sm text-fg-secondary">{t("saveFirst")}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          {canDecide && (
            <Button
              variant="secondary"
              size="sm"
              disabled={
                !!correctionBusy || !editable || !aiDraftEligible || hasUnsavedText || proposalStale
              }
              onClick={() => void accept()}
            >
              {t("accept")}
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            disabled={
              !!correctionBusy || !editable || !aiDraftEligible || hasUnsavedText || proposalStale
            }
            onClick={() => void propose(proposal.claimIndex)}
          >
            {correctionBusy === "propose" ? t("proposing") : t("tryAgain")}
          </Button>
          {canDecide && (
            <Button
              variant="ghost"
              size="sm"
              disabled={!!correctionBusy}
              onClick={() => void discard()}
            >
              {t("discard")}
            </Button>
          )}
        </div>
        <p className="mt-2 text-sm text-fg-tertiary">{t("proposalCostHint")}</p>
      </section>
    );
  }

  return (
    <Card className="mb-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-fg">{t("title")}</h2>
          <p className="mt-1 text-sm text-fg-secondary">{t("hint")}</p>
        </div>
        {editable && canDecide && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void start()}
            disabled={busy || active || hasUnsavedText || review === undefined}
          >
            {t(active ? "working" : review ? "runAgain" : "start")}
          </Button>
        )}
      </div>
      <p className="mt-3 text-sm text-fg-tertiary">{t("costHint")}</p>
      {hasUnsavedText && <p className="mt-3 text-sm text-fg-secondary">{t("saveFirst")}</p>}
      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}{" "}
          {missingKey && (
            <Link
              href={`/${locale}/settings${missingKey === "search" ? "/search" : ""}`}
              className="underline"
            >
              {t("settings")}
            </Link>
          )}
        </p>
      )}
      {review === undefined ? (
        error ? (
          <Button variant="secondary" className="mt-4" onClick={() => void load()}>
            {t("retry")}
          </Button>
        ) : (
          <Skeleton lines={2} className="mt-4" />
        )
      ) : review === null ? (
        <EmptyState
          title={t("empty")}
          action={
            <span className="text-sm text-fg-secondary">
              {t(editable ? "emptyHint" : "lockedHint")}
            </span>
          }
          className="mt-4"
        />
      ) : (
        <div className="mt-4 space-y-4">
          <p className="text-sm text-fg-secondary">
            {t(`status.${review.status}`)}
            {review.completedAt ? ` · ${new Date(review.completedAt).toLocaleString(locale)}` : ""}
          </p>
          <p className="text-sm text-fg-secondary">
            {t(review.trigger === "automatic" ? "automaticTrigger" : "manualTrigger")}
          </p>
          {stale && <p className="text-sm text-fg-secondary">{t("stale")}</p>}
          {review.status === "failed" && (
            <p className="text-sm text-danger">
              {review.errorCode ? t(`failure.${review.errorCode}`) : t("failed")}
              {(review.errorCode === "no_search_key" || review.errorCode === "no_ai_key") && (
                <>
                  {" "}
                  <Link
                    href={`/${locale}/settings${review.errorCode === "no_search_key" ? "/search" : ""}`}
                    className="underline"
                  >
                    {t("settings")}
                  </Link>
                </>
              )}
            </p>
          )}
          {review.status === "ready" && review.claims.length === 0 && (
            <p className="text-sm text-fg-secondary">{t("noClaims")}</p>
          )}
          {review.status === "ready" &&
            review.claims.map((claim, claimIndex) => (
              <div key={claim.claim} className="border-t border-border pt-3">
                <p className="text-sm font-medium text-fg">{claim.claim}</p>
                <p className="mt-1 text-sm text-fg-secondary">{t(`outcome.${claim.outcome}`)}</p>
                {claim.evidence.length > 0 && (
                  <ul className="mt-2 space-y-2">
                    {claim.evidence.map((source) => {
                      if (!isHttpUrl(source.url)) return null;
                      return (
                        <li key={`${source.url}:${source.snippet}`} className="text-sm">
                          <a
                            href={source.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-accent underline"
                          >
                            {source.title || source.url}
                          </a>
                          <p className="mt-1 text-fg-secondary">{source.snippet}</p>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {claim.outcome === "evidence_conflicts" &&
                  claim.evidence.some((source) => isHttpUrl(source.url)) &&
                  proposal === null &&
                  editable &&
                  !review.stale && (
                    <div className="mt-3">
                      {aiDraftEligible ? (
                        <>
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={hasUnsavedText || correctionBusy !== null}
                            onClick={() => void propose(claimIndex)}
                          >
                            {correctionBusy === "propose" ? t("proposing") : t("propose")}
                          </Button>
                          <p className="mt-1 text-sm text-fg-tertiary">{t("proposalCostHint")}</p>
                        </>
                      ) : (
                        <p className="text-sm text-fg-secondary">{t("aiDraftOnly")}</p>
                      )}
                    </div>
                  )}
                {proposal?.reviewId === review.id &&
                  proposal.claimIndex === claimIndex &&
                  proposalView()}
              </div>
            ))}
        </div>
      )}
      {proposal &&
        review !== undefined &&
        !(
          review?.status === "ready" &&
          proposal.reviewId === review.id &&
          review.claims[proposal.claimIndex]
        ) &&
        proposalView()}
      <Advanced label={t("historyTitle")} className="mt-4" onOpenChange={setHistoryOpen}>
        <p className="text-sm text-fg-secondary">{t("historyHint")}</p>
        {historyLoading && historyRows.length === 0 && <Skeleton lines={2} className="mt-3" />}
        {historyLoaded && !historyLoading && historyRows.length === 0 && !historyError && (
          <EmptyState
            title={t("historyEmpty")}
            action={<span className="text-sm text-fg-secondary">{t("historyEmptyHint")}</span>}
            className="mt-3"
          />
        )}
        {historyRows.length > 0 && (
          <ol className="mt-3 space-y-4">
            {historyRows.map((entry) => (
              <li key={entry.id} className="border-t border-border pt-3">
                <p className="text-sm font-medium text-fg">
                  {t("acceptedAt", { date: new Date(entry.acceptedAt).toLocaleString(locale) })}
                </p>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <div>
                    <h4 className="text-sm font-medium text-fg">{t("before")}</h4>
                    <p className="mt-1 whitespace-pre-wrap break-words text-sm text-fg-secondary">
                      {entry.claim}
                    </p>
                  </div>
                  <div>
                    <h4 className="text-sm font-medium text-fg">{t("after")}</h4>
                    <p className="mt-1 whitespace-pre-wrap break-words text-sm text-fg">
                      {entry.replacement}
                    </p>
                  </div>
                </div>
                <p className="mt-3 text-sm text-fg-secondary">{entry.reason}</p>
                {entry.evidence.length > 0 && (
                  <div className="mt-3">
                    <p className="text-sm font-medium text-fg">{t("sourceResults")}</p>
                    <ul className="mt-2 space-y-2">
                      {entry.evidence.map((source) =>
                        isHttpUrl(source.url) ? (
                          <li key={`${source.url}:${source.snippet}`} className="text-sm">
                            <a
                              href={source.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-accent underline"
                            >
                              {source.title || source.url}
                            </a>
                            <p className="mt-1 text-fg-secondary">{source.snippet}</p>
                          </li>
                        ) : null,
                      )}
                    </ul>
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
        {historyError && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {historyError}
          </p>
        )}
        {historyError && (
          <Button
            variant="secondary"
            size="sm"
            className="mt-3"
            disabled={historyLoading}
            onClick={() =>
              void loadHistory(historyRows.length > 0 ? (historyNext ?? undefined) : undefined)
            }
          >
            {t("retry")}
          </Button>
        )}
        {historyNext && !historyError && (
          <Button
            variant="secondary"
            size="sm"
            className="mt-3"
            disabled={historyLoading}
            onClick={() => void loadHistory(historyNext)}
          >
            {historyLoading ? t("historyLoading") : t("loadMore")}
          </Button>
        )}
      </Advanced>
      {notice && (
        <p role="status" className="mt-3 text-sm text-fg-secondary">
          {notice}
        </p>
      )}
      {correctionBusy === "propose" && (
        <p role="status" className="mt-3 text-sm text-fg-secondary">
          {t("proposing")}
        </p>
      )}
      {proposalError && (
        <div className="mt-3">
          <p role="alert" className="text-sm text-danger">
            {proposalError}
          </p>
          {proposal === undefined && (
            <Button
              variant="secondary"
              size="sm"
              className="mt-2"
              onClick={() => void loadProposal()}
            >
              {t("retry")}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}
