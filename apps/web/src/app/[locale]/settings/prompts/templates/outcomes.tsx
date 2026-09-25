"use client";

import {
  CONTENT_STATUSES,
  type PromptRole,
  type RoleTemplateOutcomeComparisonDto,
  type RoleTemplateOutcomeRowDto,
} from "@pubrick/shared";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { Advanced } from "@/components/ui/advanced";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage } from "@/lib/api";

type BrandOption = { id: string; name: string };
type WindowDays = 7 | 30 | 90;

export function RoleTemplateOutcomes({
  templateRole,
  activeRevisionId,
  refreshToken,
}: {
  templateRole: PromptRole;
  activeRevisionId: string | null;
  refreshToken: number;
}) {
  const t = useTranslations("RoleTemplates");
  const tp = useTranslations("Prompts");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [brands, setBrands] = useState<BrandOption[] | null>(null);
  const [brandId, setBrandId] = useState("");
  const [days, setDays] = useState<WindowDays>(30);
  const [comparison, setComparison] = useState<RoleTemplateOutcomeComparisonDto | null>(null);
  const [comparisonRefreshToken, setComparisonRefreshToken] = useState<number | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [brandError, setBrandError] = useState<string | null>(null);
  const [outcomeError, setOutcomeError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [moreBusy, setMoreBusy] = useState(false);
  const brandSequence = useRef(0);
  const outcomeSequence = useRef(0);
  const brandRequested = useRef(false);
  const lastOutcomeKey = useRef<string | null>(null);
  const visible =
    comparison?.brandId === brandId &&
    comparison.role === templateRole &&
    comparison.days === days &&
    comparisonRefreshToken === refreshToken
      ? comparison
      : null;

  const loadBrands = useCallback(async () => {
    brandRequested.current = true;
    const sequence = ++brandSequence.current;
    setBrandError(null);
    try {
      const rows = await api<BrandOption[]>("/api/brands");
      if (sequence !== brandSequence.current) return;
      setBrands(rows);
      setBrandId((selected) =>
        rows.some((brand) => brand.id === selected) ? selected : (rows[0]?.id ?? ""),
      );
    } catch (cause) {
      if (sequence === brandSequence.current) {
        setBrandError(errorMessage(cause, t("outcomesLoadError"), te));
      }
    }
  }, [t, te]);

  useEffect(() => {
    if (open && !brandRequested.current) void loadBrands();
  }, [open, loadBrands]);

  useEffect(() => {
    return () => {
      brandSequence.current += 1;
      outcomeSequence.current += 1;
    };
  }, []);

  const loadOutcomes = useCallback(
    async (force = false) => {
      if (!open || !brandId) return;
      const key = `${brandId}:${templateRole}:${days}:${refreshToken}`;
      if (!force && lastOutcomeKey.current === key) return;
      lastOutcomeKey.current = key;
      const sequence = ++outcomeSequence.current;
      setComparison(null);
      setComparisonRefreshToken(null);
      setCursor(null);
      setMoreError(null);
      setMoreBusy(false);
      setOutcomeError(null);
      try {
        const page = await api<RoleTemplateOutcomeComparisonDto>(
          `/api/prompts/brands/${brandId}/${templateRole}/templates/outcomes?days=${days}`,
        );
        if (sequence !== outcomeSequence.current) return;
        setComparison(page);
        setComparisonRefreshToken(refreshToken);
        setCursor(page.nextCursor);
      } catch (cause) {
        if (sequence === outcomeSequence.current) {
          setOutcomeError(errorMessage(cause, t("outcomesLoadError"), te));
        }
      }
    },
    [brandId, days, open, refreshToken, templateRole, t, te],
  );

  useEffect(() => {
    void loadOutcomes();
  }, [loadOutcomes]);

  async function loadMore() {
    if (!open || !brandId || cursor === null || moreBusy) return;
    const sequence = outcomeSequence.current;
    setMoreBusy(true);
    setMoreError(null);
    try {
      const page = await api<RoleTemplateOutcomeComparisonDto>(
        `/api/prompts/brands/${brandId}/${templateRole}/templates/outcomes?days=${days}&cursor=${cursor}`,
      );
      if (sequence !== outcomeSequence.current) return;
      setComparison((current) =>
        current?.brandId === brandId && current.role === templateRole && current.days === days
          ? { ...current, rows: [...current.rows, ...page.rows], nextCursor: page.nextCursor }
          : current,
      );
      setCursor(page.nextCursor);
    } catch (cause) {
      if (sequence === outcomeSequence.current) {
        setMoreError(errorMessage(cause, t("outcomesLoadError"), te));
      }
    } finally {
      if (sequence === outcomeSequence.current) setMoreBusy(false);
    }
  }

  function statusSummary(row: RoleTemplateOutcomeRowDto) {
    const statuses = CONTENT_STATUSES.filter((status) => row.currentItemStatuses[status] > 0).map(
      (status) => `${tp(`itemStatuses.${status}`)}: ${row.currentItemStatuses[status]}`,
    );
    if (row.withoutCurrentItem > 0) {
      statuses.push(`${t("outcomesWithoutItem")}: ${row.withoutCurrentItem}`);
    }
    return statuses.join(" · ") || t("outcomesNoCurrent");
  }

  const rows = visible ? [visible.default, ...visible.rows] : [];

  return (
    <Advanced label={t("outcomesTitle")} className="mb-5" open={open} onOpenChange={setOpen}>
      <div className="space-y-4">
        <p className="text-sm text-fg-secondary">{t("outcomesCaveat")}</p>
        <div className="flex flex-wrap gap-4">
          {brands && brands.length > 0 && (
            <Select
              label={t("outcomesBrand")}
              value={brandId}
              onChange={(event) => setBrandId(event.target.value)}
            >
              {brands.map((brand) => (
                <option key={brand.id} value={brand.id}>
                  {brand.name}
                </option>
              ))}
            </Select>
          )}
          <Select
            label={t("outcomesWindow")}
            value={days}
            onChange={(event) => setDays(Number(event.target.value) as WindowDays)}
          >
            {([7, 30, 90] as const).map((windowDays) => (
              <option key={windowDays} value={windowDays}>
                {tp("days", { days: windowDays })}
              </option>
            ))}
          </Select>
        </div>
        {brandError && (
          <div role="alert" className="space-y-2 text-sm text-danger">
            <p>{brandError}</p>
            <Button variant="secondary" size="sm" onClick={() => void loadBrands()}>
              {t("outcomesRetry")}
            </Button>
          </div>
        )}
        {brands === null && !brandError && (
          <div role="status" aria-label={t("outcomesLoading")}>
            <Skeleton lines={2} />
          </div>
        )}
        {brands?.length === 0 && (
          <EmptyState
            title={t("outcomesNoBrands")}
            action={
              <Link href={`/${locale}/brands`} className="text-sm text-accent underline">
                {t("outcomesAddBrand")}
              </Link>
            }
            className="py-6"
          />
        )}
        {brands && brands.length > 0 && outcomeError && (
          <div role="alert" className="space-y-2 text-sm text-danger">
            <p>{outcomeError}</p>
            <Button variant="secondary" size="sm" onClick={() => void loadOutcomes(true)}>
              {t("outcomesRetry")}
            </Button>
          </div>
        )}
        {brands && brands.length > 0 && !outcomeError && !visible && (
          <div role="status" aria-label={t("outcomesLoading")}>
            <Skeleton lines={3} />
          </div>
        )}
        {visible && (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-fg-secondary">
                  <tr>
                    <th scope="col" className="pb-2 pr-4 font-medium">
                      {t("outcomesCohort")}
                    </th>
                    <th scope="col" className="pb-2 pr-4 font-medium">
                      {t("outcomesRuns")}
                    </th>
                    <th scope="col" className="pb-2 pr-4 font-medium">
                      {t("outcomesSucceeded")}
                    </th>
                    <th scope="col" className="pb-2 pr-4 font-medium">
                      {t("outcomesPublished")}
                    </th>
                    <th scope="col" className="pb-2 pr-4 font-medium">
                      {t("outcomesApproved")}
                    </th>
                    <th scope="col" className="pb-2 pr-4 font-medium">
                      {t("outcomesRejected")}
                    </th>
                    <th scope="col" className="pb-2 font-medium">
                      {t("outcomesCurrent")}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((row) => (
                    <tr key={row.kind === "default" ? "default" : row.revisionId}>
                      <th scope="row" className="py-3 pr-4 font-medium">
                        {row.kind === "default"
                          ? t("outcomesBuiltIn")
                          : t("version", { version: row.version })}
                        {row.revisionId === activeRevisionId && (
                          <span className="ml-2 text-xs font-normal text-fg-secondary">
                            {t("outcomesActive")}
                          </span>
                        )}
                      </th>
                      <td className="py-3 pr-4">{row.runCount}</td>
                      <td className="py-3 pr-4">{row.succeededRuns}</td>
                      <td className="py-3 pr-4">{row.publishedRuns}</td>
                      <td className="py-3 pr-4">{row.reviewActs.approved}</td>
                      <td className="py-3 pr-4">{row.reviewActs.rejected}</td>
                      <td className="py-3 text-fg-secondary">{statusSummary(row)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {visible.rows.length === 0 && (
              <p className="text-sm text-fg-secondary">{t("outcomesNoRevisions")}</p>
            )}
            {moreError && (
              <p role="alert" className="text-sm text-danger">
                {moreError}
              </p>
            )}
            {cursor !== null && (
              <Button variant="secondary" disabled={moreBusy} onClick={() => void loadMore()}>
                {moreBusy ? t("outcomesLoading") : t("loadMore")}
              </Button>
            )}
          </>
        )}
      </div>
    </Advanced>
  );
}
