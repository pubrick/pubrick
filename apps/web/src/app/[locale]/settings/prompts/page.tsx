"use client";

import {
  CONTENT_STATUSES,
  PROMPT_ROLES,
  type PromptDecisionHistoryDto,
  type PromptOutcomeComparisonDto,
  type PromptRevisionDto,
  type PromptRevisionUsageDto,
  type PromptRole,
  promptRevisionCreateSchema,
  RUN_STATUSES,
} from "@pubrick/shared";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ListRow } from "@/components/ui/list-row";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage } from "@/lib/api";

const FORM_ID = "prompt-guidance-form";
type BrandOption = { id: string; name: string };

export default function PromptsPage() {
  const t = useTranslations("Prompts");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const [role, setRole] = useState<PromptRole>("researcher");
  const [history, setHistory] = useState<PromptRevisionDto[] | null>(null);
  const [guidance, setGuidance] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [usageRevisionId, setUsageRevisionId] = useState<string | null>(null);
  const [usageDays, setUsageDays] = useState<7 | 30 | 90>(30);
  const [usage, setUsage] = useState<PromptRevisionUsageDto | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [decisionRevisionId, setDecisionRevisionId] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<PromptDecisionHistoryDto | null>(null);
  const [decisionsError, setDecisionsError] = useState<string | null>(null);
  const [moreBusy, setMoreBusy] = useState(false);
  const [brands, setBrands] = useState<BrandOption[] | null>(null);
  const [outcomeBrandId, setOutcomeBrandId] = useState("");
  const [outcomes, setOutcomes] = useState<PromptOutcomeComparisonDto | null>(null);
  const [outcomesError, setOutcomesError] = useState<string | null>(null);
  const visibleOutcomes =
    outcomes?.brandId === outcomeBrandId && outcomes.role === role && outcomes.days === usageDays
      ? outcomes
      : null;
  const decisionRequestSequence = useRef(0);
  const requestSequence = useRef(0);
  const outcomeRequestSequence = useRef(0);

  useEffect(() => {
    let current = true;
    void api<BrandOption[]>("/api/brands")
      .then((result) => {
        if (!current) return;
        setBrands(result);
        setOutcomeBrandId((selected) =>
          result.some((brand) => brand.id === selected) ? selected : (result[0]?.id ?? ""),
        );
      })
      .catch((err) => {
        if (current) setOutcomesError(errorMessage(err, t("outcomesError"), te));
      });
    return () => {
      current = false;
    };
  }, [t, te]);

  const loadOutcomes = useCallback(async () => {
    const request = ++outcomeRequestSequence.current;
    setOutcomes(null);
    if (!outcomeBrandId) return;
    setOutcomesError(null);
    try {
      const result = await api<PromptOutcomeComparisonDto>(
        `/api/prompts/brands/${outcomeBrandId}/${role}/outcomes?days=${usageDays}`,
      );
      if (request === outcomeRequestSequence.current) setOutcomes(result);
    } catch (err) {
      if (request === outcomeRequestSequence.current) {
        setOutcomesError(errorMessage(err, t("outcomesError"), te));
      }
    }
  }, [outcomeBrandId, role, usageDays, t, te]);

  useEffect(() => {
    void loadOutcomes();
    return () => {
      outcomeRequestSequence.current += 1;
    };
  }, [loadOutcomes]);

  const load = useCallback(async () => {
    const request = ++requestSequence.current;
    try {
      const rows = await api<PromptRevisionDto[]>(`/api/prompts/${role}/revisions`);
      if (request !== requestSequence.current) return;
      setHistory(rows);
      setGuidance(rows[0]?.guidance ?? "");
      setError(null);
    } catch (err) {
      if (request !== requestSequence.current) return;
      setHistory([]);
      setError(errorMessage(err, t("genericError"), te));
    }
  }, [role, t, te]);

  useEffect(() => {
    setHistory(null);
    void load();
    return () => {
      requestSequence.current += 1;
    };
  }, [load]);

  useEffect(() => {
    if (!usageRevisionId) return;
    let current = true;
    setUsage(null);
    setUsageError(null);
    void api<PromptRevisionUsageDto>(
      `/api/prompts/${role}/revisions/${usageRevisionId}/usage?days=${usageDays}`,
    )
      .then((result) => {
        if (current) setUsage(result);
      })
      .catch(() => {
        if (current) setUsageError(t("usageError"));
      });
    return () => {
      current = false;
    };
  }, [role, usageRevisionId, usageDays, t]);

  useEffect(() => {
    const request = ++decisionRequestSequence.current;
    setDecisions(null);
    setDecisionsError(null);
    setMoreBusy(false);
    if (!decisionRevisionId) return;
    void api<PromptDecisionHistoryDto>(
      `/api/prompts/${role}/revisions/${decisionRevisionId}/decisions?days=${usageDays}`,
    )
      .then((result) => {
        if (request === decisionRequestSequence.current) setDecisions(result);
      })
      .catch(() => {
        if (request === decisionRequestSequence.current) setDecisionsError(t("decisionsError"));
      });
    return () => {
      decisionRequestSequence.current += 1;
    };
  }, [role, decisionRevisionId, usageDays, t]);

  async function loadMoreDecisions() {
    if (!decisions?.nextCursor || !decisionRevisionId || moreBusy) return;
    const request = decisionRequestSequence.current;
    setMoreBusy(true);
    setDecisionsError(null);
    try {
      const page = await api<PromptDecisionHistoryDto>(
        `/api/prompts/${role}/revisions/${decisionRevisionId}/decisions?days=${usageDays}&cursor=${decisions.nextCursor}`,
      );
      if (request === decisionRequestSequence.current) {
        setDecisions({ ...page, rows: [...decisions.rows, ...page.rows] });
      }
    } catch {
      if (request === decisionRequestSequence.current) setDecisionsError(t("decisionsError"));
    } finally {
      if (request === decisionRequestSequence.current) setMoreBusy(false);
    }
  }

  async function save(nextGuidance: string) {
    const parsed = promptRevisionCreateSchema.safeParse({ guidance: nextGuidance });
    if (!parsed.success) {
      setError(t("tooLong"));
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api(`/api/prompts/${role}/revisions`, {
        method: "POST",
        body: JSON.stringify(parsed.data),
      });
      await load();
      void loadOutcomes();
      setNotice(t("saved"));
    } catch (err) {
      setError(errorMessage(err, t("genericError"), te));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell
      title={t("title")}
      primaryAction={
        <Button type="submit" form={FORM_ID} disabled={busy || history === null}>
          {t("save")}
        </Button>
      }
    >
      <Link
        href={`/${locale}/settings`}
        className="mb-5 inline-block text-sm text-fg-secondary underline"
      >
        {t("back")}
      </Link>
      {error && (
        <p role="alert" className="mb-4 text-sm text-danger">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mb-4 text-sm text-fg-secondary">
          {notice}
        </p>
      )}
      <Card className="mb-6">
        <p className="mb-4 text-sm text-fg-secondary">{t("intro")}</p>
        <form
          id={FORM_ID}
          onSubmit={(event) => {
            event.preventDefault();
            void save(guidance);
          }}
          className="space-y-4"
        >
          <Select
            label={t("role")}
            value={role}
            disabled={busy}
            onChange={(event) => {
              setUsageRevisionId(null);
              setUsage(null);
              setDecisionRevisionId(null);
              setDecisions(null);
              setMoreBusy(false);
              setRole(event.target.value as PromptRole);
            }}
          >
            {PROMPT_ROLES.map((value) => (
              <option key={value} value={value}>
                {t(`roles.${value}`)}
              </option>
            ))}
          </Select>
          {history === null ? (
            <Skeleton lines={4} />
          ) : (
            <div>
              <label
                htmlFor="prompt-guidance"
                className="mb-1.5 block text-sm font-medium text-fg-secondary"
              >
                {t("guidance")}
              </label>
              <textarea
                id="prompt-guidance"
                className="min-h-52 w-full rounded-control border border-border-strong bg-panel p-3 text-sm text-fg"
                maxLength={6000}
                value={guidance}
                onChange={(event) => setGuidance(event.target.value)}
              />
              <p className="mt-1 text-xs text-fg-secondary">{t("guidanceHint")}</p>
            </div>
          )}
        </form>
      </Card>
      <div className="mb-3 flex justify-end">
        <Select
          label={t("usageWindow")}
          value={usageDays}
          disabled={busy}
          onChange={(event) => setUsageDays(Number(event.target.value) as 7 | 30 | 90)}
        >
          {[7, 30, 90].map((days) => (
            <option key={days} value={days}>
              {t("days", { days })}
            </option>
          ))}
        </Select>
      </div>
      <Card className="mb-6 space-y-4">
        <h2 className="text-lg font-semibold text-fg">{t("outcomesTitle")}</h2>
        <p className="text-sm text-fg-secondary">{t("outcomesCaveat")}</p>
        {brands && brands.length > 0 && (
          <Select
            label={t("outcomesBrand")}
            value={outcomeBrandId}
            disabled={busy}
            onChange={(event) => setOutcomeBrandId(event.target.value)}
          >
            {brands.map((brand) => (
              <option key={brand.id} value={brand.id}>
                {brand.name}
              </option>
            ))}
          </Select>
        )}
        {outcomesError && (
          <p role="alert" className="text-sm text-danger">
            {outcomesError}
          </p>
        )}
        {brands === null && !outcomesError ? (
          <Skeleton lines={2} />
        ) : brands?.length === 0 ? (
          <EmptyState
            title={t("outcomesNoBrands")}
            action={
              <Link href={`/${locale}/brands`} className="text-sm text-accent underline">
                {t("outcomesAddBrand")}
              </Link>
            }
            className="py-6"
          />
        ) : visibleOutcomes === null ? (
          !outcomesError && <Skeleton lines={3} />
        ) : visibleOutcomes.rows.length === 0 ? (
          <EmptyState
            title={t("outcomesNoRevisions")}
            action={
              <a href="#prompt-guidance" className="text-sm text-accent underline">
                {t("outcomesSaveVersion")}
              </a>
            }
            className="py-6"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-fg-secondary">
                <tr>
                  <th scope="col" className="pb-2 pr-4 font-medium">
                    {t("outcomesVersion")}
                  </th>
                  <th scope="col" className="pb-2 pr-4 font-medium">
                    {t("outcomesRuns")}
                  </th>
                  <th scope="col" className="pb-2 pr-4 font-medium">
                    {t("outcomesSucceeded")}
                  </th>
                  <th scope="col" className="pb-2 pr-4 font-medium">
                    {t("outcomesApproved")}
                  </th>
                  <th scope="col" className="pb-2 pr-4 font-medium">
                    {t("outcomesRejected")}
                  </th>
                  <th scope="col" className="pb-2 pr-4 font-medium">
                    {t("outcomesPublished")}
                  </th>
                  <th scope="col" className="pb-2 font-medium">
                    {t("outcomesCurrent")}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {visibleOutcomes.rows.map((row) => {
                  const draftStates = CONTENT_STATUSES.filter(
                    (status) => (row.currentItemStatuses[status] ?? 0) > 0,
                  ).map(
                    (status) =>
                      `${t(`itemStatuses.${status}`)}: ${row.currentItemStatuses[status]}`,
                  );
                  if (row.withoutCurrentItem > 0) {
                    draftStates.push(`${t("withoutCurrentItem")}: ${row.withoutCurrentItem}`);
                  }
                  return (
                    <tr key={row.revisionId}>
                      <th scope="row" className="py-3 pr-4 font-medium">
                        {t("version", { version: row.version })}
                      </th>
                      <td className="py-3 pr-4">{row.runCount}</td>
                      <td className="py-3 pr-4">{row.succeededRuns}</td>
                      <td className="py-3 pr-4">{row.reviewActs.approved}</td>
                      <td className="py-3 pr-4">{row.reviewActs.rejected}</td>
                      <td className="py-3 pr-4">{row.publishedRuns}</td>
                      <td className="py-3 text-fg-secondary">
                        {draftStates.join(" · ") || t("outcomesNoCurrent")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <h2 className="mb-3 text-lg font-semibold text-fg">{t("history")}</h2>
      <Card padded={false}>
        {history === null ? (
          <div className="p-4">
            <Skeleton lines={2} />
          </div>
        ) : history.length === 0 ? (
          <p className="p-4 text-sm text-fg-secondary">{t("noHistory")}</p>
        ) : (
          history.map((revision) => (
            <ListRow
              key={revision.id}
              title={t("version", { version: revision.version })}
              meta={new Date(revision.createdAt).toLocaleString(locale)}
              trailing={
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setUsageRevisionId(revision.id)}
                    aria-pressed={usageRevisionId === revision.id}
                  >
                    {t("usage")}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setDecisionRevisionId(revision.id)}
                    aria-pressed={decisionRevisionId === revision.id}
                  >
                    {t("decisions")}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy || revision.id === history[0]?.id}
                    onClick={() => void save(revision.guidance)}
                  >
                    {t("restore")}
                  </Button>
                </div>
              }
            />
          ))
        )}
      </Card>
      {usageRevisionId && (
        <Card className="mt-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-fg">
              {t("usageTitle", {
                version:
                  history?.find((revision) => revision.id === usageRevisionId)?.version ?? "?",
              })}
            </h2>
          </div>
          <p className="text-sm text-fg-secondary">{t("usageCaveat")}</p>
          {usageError ? (
            <p role="alert" className="text-sm text-danger">
              {usageError}
            </p>
          ) : usage === null ? (
            <Skeleton lines={3} />
          ) : (
            <div className="space-y-3 text-sm text-fg">
              <p>{t("runCount", { count: usage.runCount })}</p>
              {usage.runCount === 0 ? (
                <p className="text-fg-secondary">{t("noUsage")}</p>
              ) : (
                <>
                  <div>
                    <h3 className="font-medium">{t("runStatusTitle")}</h3>
                    <ul className="mt-1 space-y-1 text-fg-secondary">
                      {RUN_STATUSES.filter((status) => (usage.runsByStatus[status] ?? 0) > 0).map(
                        (status) => (
                          <li key={status}>
                            {t(`runStatuses.${status}`)}: {usage.runsByStatus[status]}
                          </li>
                        ),
                      )}
                    </ul>
                  </div>
                  <div>
                    <h3 className="font-medium">{t("itemStatusTitle")}</h3>
                    <ul className="mt-1 space-y-1 text-fg-secondary">
                      {CONTENT_STATUSES.filter(
                        (status) => (usage.currentItemStatuses[status] ?? 0) > 0,
                      ).map((status) => (
                        <li key={status}>
                          {t(`itemStatuses.${status}`)}: {usage.currentItemStatuses[status]}
                        </li>
                      ))}
                      {usage.withoutCurrentItem > 0 && (
                        <li>
                          {t("withoutCurrentItem")}: {usage.withoutCurrentItem}
                        </li>
                      )}
                    </ul>
                  </div>
                </>
              )}
            </div>
          )}
        </Card>
      )}
      {decisionRevisionId && (
        <Card className="mt-5 space-y-4">
          <h2 className="text-lg font-semibold text-fg">
            {t("decisionsTitle", {
              version:
                history?.find((revision) => revision.id === decisionRevisionId)?.version ?? "?",
            })}
          </h2>
          <p className="text-sm text-fg-secondary">{t("decisionsCaveat")}</p>
          <p className="text-xs text-fg-secondary">{t("decisionsWindow", { days: usageDays })}</p>
          {decisionsError && (
            <p role="alert" className="text-sm text-danger">
              {decisionsError}
            </p>
          )}
          {decisions === null ? (
            !decisionsError && <Skeleton lines={3} />
          ) : (
            <div className="space-y-3 text-sm">
              <p>
                {t("decisionCounts", {
                  approved: decisions.counts.approved,
                  rejected: decisions.counts.rejected,
                })}
              </p>
              {decisions.rows.length === 0 ? (
                <p className="text-fg-secondary">{t("noDecisions")}</p>
              ) : (
                <ul className="divide-y divide-border">
                  {decisions.rows.map((decision) => (
                    <li
                      key={decision.id}
                      className="flex flex-wrap items-center justify-between gap-2 py-2"
                    >
                      <span>
                        {t(`decisionVerdicts.${decision.verdict}`)} ·{" "}
                        {new Date(decision.decidedAt).toLocaleString(locale)}
                      </span>
                      {decision.itemExists ? (
                        <Link
                          href={`/${locale}/content/${decision.contentItemId}`}
                          className="text-fg-secondary underline"
                        >
                          {t("openDecisionDraft")}
                        </Link>
                      ) : (
                        <span className="text-fg-secondary">{t("removedDecisionDraft")}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {decisions.nextCursor && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={moreBusy}
                  onClick={() => void loadMoreDecisions()}
                >
                  {t("loadMoreDecisions")}
                </Button>
              )}
            </div>
          )}
        </Card>
      )}
    </AppShell>
  );
}
