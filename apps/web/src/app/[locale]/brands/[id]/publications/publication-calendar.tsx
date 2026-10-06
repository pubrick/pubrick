"use client";

import {
  hasOrganizationRole,
  isManualPlatform,
  MIN_RESCHEDULE_LEAD_MS,
  type PublicationMoveResult,
  type PublicationMoves,
  type PublicationOperationDto,
  type PublicationOperationsPageDto,
} from "@pubrick/shared";
import { DateTime } from "luxon";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { DELIVERY_BADGE_STATUS } from "@/lib/adaptations";
import { ApiError, api, errorMessage } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { platformName } from "@/lib/platform";

type OffsetOption = { instant: string; offset: string };
type LocalTime = { valid: boolean; options: OffsetOption[] };
type Edit = { value: string; instant: string };
type Channel = { id: string; name: string };
type Move = PublicationMoves["moves"][number];

/** Luxon normalizes DST gaps, so compare the requested wall clock before offering an instant. */
export function publicationLocalTime(value: string, timezone: string): LocalTime {
  const local = DateTime.fromISO(value, { zone: timezone });
  if (!local.isValid || local.toFormat("yyyy-MM-dd'T'HH:mm") !== value.slice(0, 16))
    return { valid: false, options: [] };
  const options = local
    .getPossibleOffsets()
    .sort((left, right) => left.toMillis() - right.toMillis())
    .flatMap((candidate) => {
      const instant = candidate.toUTC().toISO();
      return instant ? [{ instant, offset: `UTC${candidate.toFormat("ZZ")}` }] : [];
    });
  return { valid: options.length > 0, options };
}

export function publicationRange(day: string, mode: "week" | "day", timezone: string) {
  const start = DateTime.fromISO(day, { zone: timezone }).startOf(mode);
  const end = start.plus({ days: mode === "week" ? 7 : 1 });
  const from = start.toUTC().toISO();
  const to = end.toUTC().toISO();
  if (!start.isValid || !from || !to) return null;
  return { start, from, to, days: mode === "week" ? 7 : 1 };
}

export function PublicationCalendar({
  brandId,
  initialDay,
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone,
}: {
  brandId: string;
  initialDay?: string;
  timezone?: string;
}) {
  const locale = useLocale();
  const router = useRouter();
  const t = useTranslations("PublicationCalendar");
  const tc = useTranslations("Content");
  const te = useTranslations("Errors");
  const tOperations = useTranslations("PublicationOperations");
  const { data: session } = authClient.useSession();
  const { data: organization } = authClient.useActiveOrganization();
  const role = organization?.members?.find((member) => member.userId === session?.user.id)?.role;
  const canMove = hasOrganizationRole(role, ["owner", "admin", "member", "editor"]);
  const [day, setDay] = useState(
    () => initialDay ?? DateTime.now().setZone(timezone).toISODate() ?? "",
  );
  const [mode, setMode] = useState<"week" | "day">("week");
  const [channelId, setChannelId] = useState("");
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelsError, setChannelsError] = useState<string | null>(null);
  const [rows, setRows] = useState<PublicationOperationDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, PublicationOperationDto>>({});
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [stage, setStage] = useState<"edit" | "confirm" | null>(null);
  const [moves, setMoves] = useState<Move[]>([]);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [requiresReload, setRequiresReload] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const version = useRef(0);
  const alive = useRef(true);
  const range = useMemo(() => publicationRange(day, mode, timezone), [day, mode, timezone]);
  const scope = `${organization?.id ?? ""}/${brandId}/${range?.from}/${range?.to}/${channelId}`;
  const activeScope = useRef(scope);
  activeScope.current = scope;
  const selectedRows = Object.values(selected);
  const selectionBusy = selectedRows.length > 0 || busy;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      ++version.current;
    };
  }, []);

  const describeError = useCallback(
    (cause: unknown, fallback: string) => {
      if (cause instanceof ApiError && cause.noActiveOrg) {
        router.replace(`/${locale}/onboarding`);
        return null;
      }
      return errorMessage(cause, fallback, te);
    },
    [locale, router, te],
  );

  const load = useCallback(
    async (next: string | null = null) => {
      if (!range) return false;
      const requestScope = scope;
      const requestVersion = ++version.current;
      setLoading(true);
      setLoadError(null);
      if (!next) {
        setRows([]);
        setCursor(null);
        setSelected({});
        setStage(null);
        setMoves([]);
      }
      try {
        const query = new URLSearchParams({ filter: "scheduled", from: range.from, to: range.to });
        if (channelId) query.set("channelId", channelId);
        if (next) query.set("cursor", next);
        const page = await api<PublicationOperationsPageDto>(
          `/api/brands/${brandId}/publications?${query}`,
          { cache: "no-store" },
        );
        if (
          !alive.current ||
          requestVersion !== version.current ||
          activeScope.current !== requestScope
        )
          return false;
        setRows((previous) => {
          const all = next ? [...previous, ...page.rows] : page.rows;
          return [...new Map(all.map((row) => [row.id, row])).values()];
        });
        setCursor(page.nextCursor);
        if (!next) setRequiresReload(false);
        return true;
      } catch (cause) {
        if (
          alive.current &&
          requestVersion === version.current &&
          activeScope.current === requestScope
        )
          setLoadError(describeError(cause, t("loadError")));
        return false;
      } finally {
        if (
          alive.current &&
          requestVersion === version.current &&
          activeScope.current === requestScope
        )
          setLoading(false);
      }
    },
    [brandId, channelId, describeError, range, scope, t],
  );

  useEffect(() => {
    setBusy(false);
    setMoveError(null);
    setNotice(null);
    void load();
    return () => {
      ++version.current;
    };
  }, [load]);

  useEffect(() => {
    let stale = false;
    const organizationScope = `${organization?.id ?? ""}/${brandId}/`;
    setChannels([]);
    setChannelsError(null);
    api<Channel[]>(`/api/channels?brandId=${brandId}`, { cache: "no-store" })
      .then((result) => {
        if (!stale && activeScope.current.startsWith(organizationScope)) setChannels(result);
      })
      .catch((cause) => {
        if (!stale && activeScope.current.startsWith(organizationScope))
          setChannelsError(describeError(cause, t("channelsError")));
      });
    return () => {
      stale = true;
    };
  }, [brandId, organization?.id, describeError, t]);

  const date = (instant: string) =>
    DateTime.fromISO(instant, { setZone: true })
      .setZone(timezone)
      .setLocale(locale)
      .toLocaleString(DateTime.DATETIME_MED_WITH_SECONDS);
  const localInput = (instant: string) =>
    DateTime.fromISO(instant, { setZone: true })
      .setZone(timezone)
      .toFormat("yyyy-MM-dd'T'HH:mm:ss.SSS");
  const movable = (row: PublicationOperationDto) =>
    canMove &&
    !requiresReload &&
    row.deliveryOutcome === "scheduled" &&
    !isManualPlatform(row.platform) &&
    row.scheduledAt !== null &&
    Number.isInteger(row.attemptCount) &&
    row.attemptCount >= 0 &&
    Date.parse(row.scheduledAt) > Date.now() + MIN_RESCHEDULE_LEAD_MS;

  function toggle(row: PublicationOperationDto, checked: boolean) {
    if (busy || !movable(row)) return;
    setMoveError(null);
    setSelected((current) => {
      if (checked && Object.keys(current).length >= 20) return current;
      const next = { ...current };
      if (checked) next[row.id] = { ...row };
      else delete next[row.id];
      return next;
    });
  }

  function editSelected() {
    if (busy || requiresReload || selectedRows.length === 0 || !canMove) return;
    setEdits(
      Object.fromEntries(
        selectedRows.map((row) => [
          row.id,
          { value: localInput(row.scheduledAt as string), instant: "" },
        ]),
      ),
    );
    setMoveError(null);
    setStage("edit");
  }

  function previewMoves() {
    const proposed: Move[] = [];
    for (const row of selectedRows) {
      const edit = edits[row.id];
      const parsed = publicationLocalTime(edit?.value ?? "", timezone);
      if (!parsed.valid) {
        setMoveError(t("invalidLocalTime"));
        return;
      }
      const option =
        parsed.options.length === 1
          ? parsed.options[0]
          : parsed.options.find((candidate) => candidate.instant === edit?.instant);
      if (!option) {
        setMoveError(t("chooseOffset"));
        return;
      }
      if (
        !row.scheduledAt ||
        Math.min(Date.parse(row.scheduledAt), Date.parse(option.instant)) <=
          Date.now() + MIN_RESCHEDULE_LEAD_MS
      ) {
        setMoveError(te("schedule_too_close"));
        return;
      }
      proposed.push({
        adaptationId: row.id,
        expectedScheduledAt: row.scheduledAt,
        expectedAttemptCount: row.attemptCount,
        scheduledAt: option.instant,
      });
    }
    if (proposed.every((move) => move.scheduledAt === move.expectedScheduledAt)) {
      setMoveError(t("noChanges"));
      return;
    }
    setMoves(proposed);
    setMoveError(null);
    setStage("confirm");
  }

  function swap() {
    if (busy || requiresReload || selectedRows.length !== 2 || !canMove) return;
    const [first, second] = selectedRows;
    if (
      !first ||
      !second ||
      first.channelId !== second.channelId ||
      !first.scheduledAt ||
      !second.scheduledAt
    )
      return;
    setMoves([
      {
        adaptationId: first.id,
        expectedScheduledAt: first.scheduledAt,
        expectedAttemptCount: first.attemptCount,
        scheduledAt: second.scheduledAt,
      },
      {
        adaptationId: second.id,
        expectedScheduledAt: second.scheduledAt,
        expectedAttemptCount: second.attemptCount,
        scheduledAt: first.scheduledAt,
      },
    ]);
    setMoveError(null);
    setStage("confirm");
  }

  async function confirm() {
    if (busy || requiresReload || stage !== "confirm" || moves.length === 0 || !canMove) return;
    const requestScope = scope;
    setBusy(true);
    setMoveError(null);
    try {
      await api<PublicationMoveResult>(`/api/brands/${brandId}/publications/reschedule`, {
        method: "POST",
        body: JSON.stringify({ moves }),
      });
    } catch (cause) {
      if (alive.current && activeScope.current === requestScope) {
        setMoveError(describeError(cause, t("moveError")));
        setRequiresReload(true);
        setStage(null);
        setMoves([]);
        setSelected({});
        setBusy(false);
      }
      return;
    }
    if (!alive.current || activeScope.current !== requestScope) return;
    setStage(null);
    setMoves([]);
    setSelected({});
    setNotice(t("moved"));
    // A committed move remains successful if its follow-up read fails.
    const refreshed = await load();
    if (alive.current && activeScope.current === requestScope) {
      if (!refreshed) setNotice(t("movedRefreshFailed"));
      setBusy(false);
    }
  }

  function close() {
    if (busy) return;
    setStage(null);
    setMoveError(null);
  }

  if (!range) return <p role="alert">{t("invalidRange")}</p>;
  const days = Array.from({ length: range.days }, (_, index) => range.start.plus({ days: index }));
  const sameChannelPair =
    selectedRows.length === 2 && selectedRows[0]?.channelId === selectedRows[1]?.channelId;

  return (
    <section aria-label={t("title")}>
      <p className="mb-4 text-sm text-fg-secondary">{t("intro")}</p>
      <p className="mb-4 text-sm text-fg-secondary">{t("timezone", { timezone })}</p>
      <div className="mb-5 flex flex-wrap items-end gap-3">
        <fieldset disabled={selectionBusy} className="contents">
          <Segmented
            options={[
              { value: "week", label: t("week") },
              { value: "day", label: t("day") },
            ]}
            value={mode}
            onChange={(value) => {
              if (!selectionBusy && (value === "week" || value === "day")) setMode(value);
            }}
            className={`[&_button]:min-h-11 ${selectionBusy ? "opacity-50" : ""}`}
          />
        </fieldset>
        <Input
          type="date"
          label={t("date")}
          value={day}
          disabled={selectionBusy}
          onChange={(event) => {
            if (event.target.value) setDay(event.target.value);
          }}
          className="min-h-11"
        />
        <Select
          label={t("channel")}
          value={channelId}
          disabled={selectionBusy}
          onChange={(event) => setChannelId(event.target.value)}
          className="min-h-11"
        >
          <option value="">{t("allChannels")}</option>
          {channels.map((channel) => (
            <option key={channel.id} value={channel.id}>
              {channel.name}
            </option>
          ))}
        </Select>
        <Button
          variant="secondary"
          disabled={selectionBusy}
          className="min-h-11"
          onClick={() => setDay(range.start.minus({ days: range.days }).toISODate() as string)}
        >
          {t("previous")}
        </Button>
        <Button
          variant="secondary"
          disabled={selectionBusy}
          className="min-h-11"
          onClick={() => setDay(DateTime.now().setZone(timezone).toISODate() as string)}
        >
          {t("today")}
        </Button>
        <Button
          variant="secondary"
          disabled={selectionBusy}
          className="min-h-11"
          onClick={() => setDay(range.start.plus({ days: range.days }).toISODate() as string)}
        >
          {t("next")}
        </Button>
        <Button
          variant="secondary"
          disabled={loading || busy}
          className="min-h-11"
          onClick={() => void load()}
        >
          {t("reload")}
        </Button>
      </div>
      {channelsError && (
        <p role="alert" className="mb-3 text-sm text-danger">
          {channelsError}
        </p>
      )}
      {notice && (
        <p role="status" className="mb-3 text-sm text-fg-secondary">
          {notice}
        </p>
      )}
      {loadError && (
        <p role="alert" className="mb-3 text-sm text-danger">
          {loadError}
        </p>
      )}
      {moveError && stage === null && (
        <p role="alert" className="mb-3 text-sm text-danger">
          {moveError}
        </p>
      )}
      {requiresReload && (
        <p role="status" className="mb-3 text-sm text-fg-secondary">
          {t("reloadRequired")}
        </p>
      )}
      {canMove && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <p role="status" className="text-sm text-fg-secondary">
            {t("selection", { count: selectedRows.length })}
          </p>
          <Button
            variant="secondary"
            className="min-h-11"
            disabled={selectedRows.length === 0 || busy || requiresReload}
            onClick={editSelected}
          >
            {t("move")}
          </Button>
          {sameChannelPair && (
            <Button
              variant="secondary"
              className="min-h-11"
              disabled={busy || requiresReload}
              onClick={swap}
            >
              {t("swap")}
            </Button>
          )}
          {selectedRows.length > 0 && (
            <Button
              variant="ghost"
              className="min-h-11"
              disabled={busy}
              onClick={() => setSelected({})}
            >
              {t("clear")}
            </Button>
          )}
        </div>
      )}
      {loading && rows.length === 0 ? (
        <Skeleton lines={5} />
      ) : rows.length === 0 && loadError ? null : rows.length === 0 && !cursor ? (
        <EmptyState
          title={t("emptyRange")}
          action={
            <Link
              href={`/${locale}/content`}
              className="inline-flex min-h-11 items-center text-sm text-accent underline"
            >
              {tOperations("openQueue")}
            </Link>
          }
        />
      ) : (
        <div className="space-y-4">
          {days.map((dateDay) => {
            const dateKey = dateDay.toISODate();
            const deliveries = rows.filter(
              (row) =>
                row.scheduledAt &&
                DateTime.fromISO(row.scheduledAt, { setZone: true })
                  .setZone(timezone)
                  .toISODate() === dateKey,
            );
            return (
              <Card key={dateKey}>
                <h3 className="mb-3 text-sm font-semibold text-fg">
                  {dateDay.setLocale(locale).toLocaleString(DateTime.DATE_HUGE)}
                </h3>
                {deliveries.length === 0 ? (
                  <p className="text-sm text-fg-tertiary">
                    {cursor ? t("dayNotLoaded") : t("emptyDay")}
                  </p>
                ) : (
                  <ul className="space-y-3">
                    {deliveries.map((row) => (
                      <li key={row.id} className="flex items-start gap-3">
                        {canMove && (
                          <label className="flex min-h-11 min-w-11 shrink-0 items-center justify-center">
                            <input
                              type="checkbox"
                              aria-label={t("select", {
                                title: row.title || tc("untitled"),
                                channel: row.channelName,
                              })}
                              checked={Boolean(selected[row.id])}
                              disabled={
                                busy ||
                                !movable(row) ||
                                (!selected[row.id] && selectedRows.length >= 20)
                              }
                              onChange={(event) => toggle(row, event.target.checked)}
                              className="h-5 w-5 accent-[var(--accent)]"
                            />
                          </label>
                        )}
                        <div className="min-w-0 flex-1">
                          <Link
                            href={`/${locale}/content/${row.contentItemId}#adaptation-${row.id}`}
                            className="block min-h-11 break-words py-2 font-semibold text-fg hover:text-accent"
                          >
                            {row.title || tc("untitled")}
                          </Link>
                          <p className="break-words text-sm text-fg-secondary">
                            {row.channelName} · {platformName(row.platform)}
                          </p>
                          <p className="text-sm text-fg-secondary">
                            {row.scheduledAt && date(row.scheduledAt)}
                          </p>
                          {canMove && !movable(row) && (
                            <p className="mt-1 text-xs text-fg-tertiary">{t("moveUnavailable")}</p>
                          )}
                        </div>
                        <StatusBadge status={DELIVERY_BADGE_STATUS[row.deliveryOutcome]}>
                          {tc(`adaptationStatus.${row.deliveryOutcome}`)}
                        </StatusBadge>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            );
          })}
        </div>
      )}
      {cursor && (
        <div className="mt-5 space-y-2 text-center">
          <p role="status" className="text-sm text-fg-secondary">
            {t("partialRange")}
          </p>
          <Button
            variant="secondary"
            className="min-h-11"
            disabled={loading || busy || requiresReload}
            onClick={() => void load(cursor)}
          >
            {loading ? t("loading") : t("loadMore")}
          </Button>
        </div>
      )}
      <Modal
        open={stage !== null}
        onClose={close}
        title={t(stage === "confirm" ? "confirmTitle" : "editTitle")}
        footer={
          <>
            <Button variant="ghost" className="min-h-11" disabled={busy} onClick={close}>
              {t("cancel")}
            </Button>
            <Button
              className="min-h-11"
              disabled={busy}
              onClick={stage === "confirm" ? () => void confirm() : previewMoves}
            >
              {busy ? t("saving") : t(stage === "confirm" ? "confirm" : "preview")}
            </Button>
          </>
        }
      >
        <p className="mb-4 text-sm text-fg-secondary">{t("timezone", { timezone })}</p>
        {moveError && (
          <p role="alert" className="mb-3 text-sm text-danger">
            {moveError}
          </p>
        )}
        {stage === "edit" ? (
          <div className="space-y-5 break-words">
            {selectedRows.map((row) => {
              const edit = edits[row.id] ?? { value: "", instant: "" };
              const parsed = publicationLocalTime(edit.value, timezone);
              return (
                <div key={row.id}>
                  <p className="mb-2 text-sm font-semibold">
                    {row.title || tc("untitled")} · {row.channelName}
                  </p>
                  <Input
                    type="datetime-local"
                    step="0.001"
                    label={t("newTime", { title: row.title || tc("untitled") })}
                    value={edit.value}
                    disabled={busy}
                    className="min-h-11 w-full min-w-0"
                    onChange={(event) =>
                      setEdits((current) => ({
                        ...current,
                        [row.id]: { value: event.target.value, instant: "" },
                      }))
                    }
                  />
                  {parsed.options.length > 1 && (
                    <Select
                      label={t("offset", { title: row.title || tc("untitled") })}
                      value={edit.instant}
                      disabled={busy}
                      className="mt-2 min-h-11 w-full min-w-0"
                      onChange={(event) =>
                        setEdits((current) => ({
                          ...current,
                          [row.id]: { ...edit, instant: event.target.value },
                        }))
                      }
                    >
                      <option value="">{t("chooseOffset")}</option>
                      {parsed.options.map((option) => (
                        <option key={option.instant} value={option.instant}>
                          {option.offset} · {option.instant}
                        </option>
                      ))}
                    </Select>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <>
            <p className="mb-4 text-sm text-fg-secondary">{t("confirmHint")}</p>
            <ul className="space-y-4">
              {moves.map((move) => {
                const row = selected[move.adaptationId];
                return (
                  <li key={move.adaptationId} className="break-words text-sm">
                    <p className="font-semibold">
                      {row?.title || tc("untitled")} · {row?.channelName}
                    </p>
                    <p>
                      {t("oldTime")}: {date(move.expectedScheduledAt)} · {move.expectedScheduledAt}
                    </p>
                    <p>
                      {t("newTimeLabel")}: {date(move.scheduledAt)} · {move.scheduledAt}
                    </p>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Modal>
    </section>
  );
}
