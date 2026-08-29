"use client";

import { MAX_BODY_LENGTH } from "@pubrick/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { use, useCallback, useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { OriginBadge } from "@/components/origin-badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DimmedTextarea } from "@/components/ui/dimmed-textarea";
import { Input } from "@/components/ui/input";
import { StatusBadge, type StatusBadgeStatus } from "@/components/ui/status-badge";
import { ApiError, api, apiVoid, errorMessage } from "@/lib/api";
import { isLinkableUrl } from "@/lib/external-url";
import { type AiVersionBodies, type ContentOrigin, deriveOrigin } from "@/lib/origin";
import { adaptationLimit, channelLabel as platformChannelLabel } from "@/lib/platform";

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
  origin: ContentOrigin;
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
  origin: ContentOrigin;
  createdAt: string;
  updatedAt: string;
  adaptations: Adaptation[];
  /**
   * The lens's reference text: every `ai` version body, for the item and for
   * each adaptation under its own id. Computing the mask here rather than
   * asking the server for one is deliberate (design §4) — a server-computed
   * mask would still have to be aligned to a split done in the browser, and
   * two splitters that must agree are two splitters that will stop agreeing.
   */
  aiVersionBodies: AiVersionBodies;
};

/**
 * One frozen empty array for every adaptation with no `ai` version of its own.
 * A fresh `[]` per render would be a new dependency for `DimmedTextarea`'s
 * `useMemo` every time, re-splitting the text on every keystroke elsewhere on
 * the page.
 */
const NO_AI_VERSIONS: readonly string[] = [];

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
  /**
   * The lens, off by default (design §5).
   *
   * A written trade, not a leftover: the dossier's §5.3 argues AI text should
   * be visibly AI, which points at "on", while its §2.3 keeps the writing
   * surface calm. The badge already carries the claim at a glance on every
   * card, and the lens is for when you want the detail — so it ships off, and
   * the choice lives in the design document rather than buried in a default.
   */
  const [lens, setLens] = useState(false);

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

  /**
   * The read receipt: the one signal that says a human looked at this draft.
   *
   * Its own effect, deliberately NOT chained onto the GET above. `markOpened`
   * is what clears the publish gate for an AI-written draft, so it has to mean
   * "a person had this on screen" and nothing else — a reload triggered by
   * saving the body, or a future prefetch, must not stamp it again. The ref
   * holds the id it was fired for, so it fires exactly once per item even
   * through StrictMode's double-invoked effects, and again if this component is
   * ever reused for a different id.
   *
   * A failure is swallowed on purpose: this is not a user action, and an alert
   * about a receipt would be noise about something they did not do. The
   * consequence of it failing is visible and specific anyway — approval says
   * that nobody has read the draft yet.
   */
  const openedFor = useRef<string | null>(null);
  useEffect(() => {
    if (openedFor.current === id) return;
    openedFor.current = id;
    apiVoid(`/api/content/${id}/opened`, { method: "POST" }).catch(() => {});
  }, [id]);

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

  /**
   * The counter's denominator for one channel's override (design §6). An
   * unresolved channel — deleted, or `GET /api/channels` failed and `channels`
   * is `[]` — keeps what the API can store, the same fallback
   * `adaptationLimit` makes for an id it does not know.
   */
  function overrideLimit(channelId: string): number {
    const ch = channels.find((c) => c.id === channelId);
    return ch ? adaptationLimit(ch.platform) : MAX_BODY_LENGTH;
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
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm font-medium text-fg-secondary">
        {tc(`status.${item.status}`)}
        <OriginBadge origin={deriveOrigin(item)} />
        {/*
          The lens switch: one control for the whole screen (constitution: one
          place), and a checkbox rather than a button so a view option can
          never read as, or compete with, this screen's primary action.
        */}
        <label className="ml-auto flex cursor-pointer items-center gap-2 font-normal">
          <input
            type="checkbox"
            checked={lens}
            onChange={(e) => setLens(e.target.checked)}
            className="h-4 w-4 accent-accent"
          />
          {t("lensToggle")}
        </label>
      </div>
      {error && (
        <p role="alert" className="mb-4 text-sm text-danger">
          {error}
        </p>
      )}

      <Card className="mb-6">
        <DimmedTextarea
          id="body"
          label={t("bodyLabel")}
          value={bodyDraft}
          onChange={setBodyDraft}
          aiVersions={item.aiVersionBodies.item}
          dimmed={lens}
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
            <DimmedTextarea
              value={overrideDrafts[a.id] ?? ""}
              onChange={(value) => setOverrideDrafts({ ...overrideDrafts, [a.id]: value })}
              /*
               * This adaptation's OWN `ai` versions. Not the item's, and not
               * every adaptation's joined together: a human who wrote the same
               * words for a channel the model never adapted would see their
               * own sentences painted as the model's — the one direction
               * provenance may not fail in.
               */
              aiVersions={item.aiVersionBodies.adaptations[a.id] ?? NO_AI_VERSIONS}
              dimmed={lens}
              placeholder={t("overridePlaceholder")}
              /*
               * The counter drops to what this platform accepts; the cap does
               * not follow it down (design §6). An override already longer
               * than the platform limit has to stay editable, or it is
               * unfixable forever.
               */
              displayLimit={overrideLimit(a.channelId)}
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
