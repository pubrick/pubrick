"use client";

import { MAX_BODY_LENGTH } from "@pubrick/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { use, useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { StatusBadge, type StatusBadgeStatus } from "@/components/ui/status-badge";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, api, errorMessage } from "@/lib/api";
import { isLinkableUrl } from "@/lib/external-url";
import { channelLabel as platformChannelLabel } from "@/lib/platform";

type ContentStatus = "draft" | "approved" | "rejected" | "published" | "failed";
type AdaptationStatus = "pending" | "scheduled" | "queued" | "publishing" | "published" | "failed";

// Spec §2.4's five status colors. "queued"/"publishing" share "scheduled"'s
// blue — their own translated labels are unaffected, only the color is
// shared — matching the mapping used on the queue screen.
const ADAPTATION_BADGE_STATUS: Record<AdaptationStatus, StatusBadgeStatus> = {
  pending: "draft",
  scheduled: "scheduled",
  queued: "scheduled",
  publishing: "scheduled",
  published: "published",
  failed: "failed",
};

type Channel = { id: string; platform: string; name: string };

type Adaptation = {
  id: string;
  contentItemId: string;
  channelId: string;
  body: string | null;
  status: AdaptationStatus;
  scheduledAt: string | null;
  attemptCount: number;
  lastError: string | null;
  externalUrl: string | null;
};

type ContentItem = {
  id: string;
  brandId: string;
  title: string | null;
  body: string;
  status: ContentStatus;
  createdAt: string;
  updatedAt: string;
  adaptations: Adaptation[];
};

export default function ContentItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations("Publish");
  const tc = useTranslations("Content");
  const locale = useLocale();
  const router = useRouter();

  const [item, setItem] = useState<ContentItem | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [bodyDraft, setBodyDraft] = useState("");
  const [overrideDrafts, setOverrideDrafts] = useState<Record<string, string>>({});
  const [scheduledAt, setScheduledAt] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.noActiveOrg) {
        router.replace(`/${locale}/onboarding`);
        return;
      }
      setError(errorMessage(err, t("genericError")));
    },
    [router, locale, t],
  );

  const load = useCallback(() => {
    return api<ContentItem>(`/api/content/${id}`)
      .then((it) => {
        setItem(it);
        setBodyDraft(it.body);
        setOverrideDrafts(Object.fromEntries(it.adaptations.map((a) => [a.id, a.body ?? ""])));
        return api<Channel[]>(`/api/channels?brandId=${it.brandId}`).then(setChannels);
      })
      .catch(handleError);
  }, [id, handleError]);

  useEffect(() => {
    // load() now returns its promise (see below) so the four mutation
    // handlers can await the reload instead of firing it and moving on.
    // useEffect requires void | (() => void), so the promise is discarded
    // here rather than returned directly — otherwise React treats it as an
    // attempted cleanup function and throws on unmount ("destroy is not a
    // function").
    load();
  }, [load]);

  async function saveBody() {
    setError(null);
    try {
      await api(`/api/content/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ body: bodyDraft }),
      });
      await load();
    } catch (err) {
      handleError(err);
    }
  }

  async function saveOverride(adaptationId: string) {
    setError(null);
    const value = overrideDrafts[adaptationId] ?? "";
    try {
      await api(`/api/content/${id}/adaptations/${adaptationId}`, {
        method: "PATCH",
        body: JSON.stringify({ body: value.trim() === "" ? null : value }),
      });
      await load();
    } catch (err) {
      handleError(err);
    }
  }

  async function approve(withSchedule: boolean) {
    setError(null);
    try {
      await api(`/api/content/${id}/approve`, {
        method: "POST",
        body: JSON.stringify(
          withSchedule && scheduledAt ? { scheduledAt: new Date(scheduledAt).toISOString() } : {},
        ),
      });
      await load();
    } catch (err) {
      handleError(err);
    }
  }

  async function reject() {
    setError(null);
    try {
      await api(`/api/content/${id}/reject`, { method: "POST", body: JSON.stringify({}) });
      await load();
    } catch (err) {
      handleError(err);
    }
  }

  function channelLabel(channelId: string): string {
    const ch = channels.find((c) => c.id === channelId);
    return ch ? platformChannelLabel(ch.platform, ch.name) : channelId;
  }

  if (!item) {
    return (
      <AppShell title={tc("untitled")}>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </AppShell>
    );
  }

  const isPublished = item.status === "published";

  return (
    <AppShell
      title={item.title || tc("untitled")}
      primaryAction={
        <div className="flex items-center gap-2">
          <Button variant="primary" onClick={() => approve(false)} disabled={isPublished}>
            {t("approveNow")}
          </Button>
          <Button variant="danger" onClick={reject} disabled={isPublished}>
            {t("reject")}
          </Button>
        </div>
      }
    >
      <p className="mb-3">
        <Link href={`/${locale}/content`} className="text-sm text-fg-secondary hover:text-accent">
          {t("backToQueue")}
        </Link>
      </p>
      <p className="mb-4 text-sm font-medium text-fg-secondary">{tc(`status.${item.status}`)}</p>
      {error && (
        <p role="alert" className="mb-4 text-sm text-danger">
          {error}
        </p>
      )}

      <Card className="mb-6">
        <Textarea
          id="body"
          label={t("bodyLabel")}
          value={bodyDraft}
          onChange={(e) => setBodyDraft(e.target.value)}
          maxLength={MAX_BODY_LENGTH}
          showCount
          rows={10}
        />
        <div className="mt-3">
          <Button variant="secondary" onClick={saveBody}>
            {t("saveBody")}
          </Button>
        </div>
      </Card>

      <h2 className="mb-3 text-lg font-semibold text-fg">{t("overridesTitle")}</h2>
      <div className="mb-6 flex flex-col gap-3">
        {item.adaptations.map((a) => (
          <Card key={a.id}>
            <div className="mb-3 flex items-center gap-2">
              <strong className="text-sm font-semibold text-fg">{channelLabel(a.channelId)}</strong>
              <StatusBadge status={ADAPTATION_BADGE_STATUS[a.status]}>
                {tc(`adaptationStatus.${a.status}`)}
              </StatusBadge>
            </div>
            <Textarea
              value={overrideDrafts[a.id] ?? ""}
              onChange={(e) => setOverrideDrafts({ ...overrideDrafts, [a.id]: e.target.value })}
              placeholder={t("overridePlaceholder")}
              maxLength={MAX_BODY_LENGTH}
              showCount
              rows={4}
            />
            <div className="mt-3">
              <Button variant="secondary" size="sm" onClick={() => saveOverride(a.id)}>
                {t("saveOverride")}
              </Button>
            </div>
          </Card>
        ))}
      </div>

      {/*
        A published item has nothing left to decide: the post is live in the
        channel, and the api answers both endpoints with a 409 (see
        ContentRepository.requireNotPublished). Offering the buttons anyway is
        offering a choice that no longer exists, so they are disabled and the
        reason is spelled out rather than left to be discovered by clicking.
        Approve/Reject moved into the AppShell header (constitution: they are
        this screen's primary actions) — only the schedule row still lives
        here, since "Approve with schedule" is a secondary path next to the
        date field it depends on.
      */}
      <Card className="mb-6">
        {isPublished && <p className="mb-3 text-sm text-fg-secondary">{t("alreadyPublished")}</p>}
        <div className="flex flex-wrap items-end gap-3">
          <Input
            id="scheduledAt"
            type="datetime-local"
            label={t("scheduleLabel")}
            value={scheduledAt}
            onChange={(e) => setScheduledAt(e.target.value)}
            disabled={isPublished}
          />
          <Button
            variant="secondary"
            onClick={() => approve(true)}
            disabled={isPublished || !scheduledAt}
          >
            {t("approveScheduled")}
          </Button>
        </div>
      </Card>

      <h2 className="mb-3 text-lg font-semibold text-fg">{t("resultsTitle")}</h2>
      <ul>
        {item.adaptations.map((a) => (
          <li
            key={a.id}
            className="flex flex-col gap-1 border-b border-border-soft py-3 last:border-b-0"
          >
            <div className="flex flex-wrap items-center gap-2">
              <strong className="text-sm font-semibold text-fg">{channelLabel(a.channelId)}</strong>
              <StatusBadge status={ADAPTATION_BADGE_STATUS[a.status]}>
                {tc(`adaptationStatus.${a.status}`)}
              </StatusBadge>
            </div>
            {a.status === "published" &&
              (isLinkableUrl(a.externalUrl) ? (
                <a
                  href={a.externalUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-accent hover:underline"
                >
                  {t("viewPost")}
                </a>
              ) : (
                // No link, or one whose scheme we will not put in an href:
                // show what was recorded when there is something to show.
                <span className="text-sm text-fg-tertiary">
                  {a.externalUrl ?? t("linkUnavailable")}
                </span>
              ))}
            {a.status === "failed" && a.lastError && (
              <p role="alert" className="text-sm text-danger">
                {a.lastError}
              </p>
            )}
            {a.status === "scheduled" && a.scheduledAt && (
              <span className="text-sm text-fg-tertiary">
                {t("scheduledFor")} {new Date(a.scheduledAt).toLocaleString(locale)}
              </span>
            )}
          </li>
        ))}
      </ul>
    </AppShell>
  );
}
