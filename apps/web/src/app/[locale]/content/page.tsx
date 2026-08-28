"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { IconPlus } from "@/components/ui/icons";
import { Segmented } from "@/components/ui/segmented";
import { StatusBadge, type StatusBadgeStatus } from "@/components/ui/status-badge";
import { ApiError, api, errorMessage } from "@/lib/api";
import { isLinkableUrl } from "@/lib/external-url";

type ContentStatus = "draft" | "approved" | "rejected" | "published" | "failed";
type AdaptationStatus = "pending" | "scheduled" | "queued" | "publishing" | "published" | "failed";

const STATUSES: ContentStatus[] = ["draft", "approved", "rejected", "published", "failed"];

// Spec §2.4's five status colors, mapped from every adaptation status that
// exists today. "queued"/"publishing" both read as the same in-flight blue
// as "scheduled" — their own labels still come through unchanged, only the
// color is shared.
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
  channelId: string;
  status: AdaptationStatus;
  externalUrl: string | null;
  lastError: string | null;
};

type ContentItem = {
  id: string;
  title: string | null;
  status: ContentStatus;
  adaptations: Adaptation[];
};

export default function ContentQueuePage() {
  const t = useTranslations("Content");
  const locale = useLocale();
  const router = useRouter();

  const [items, setItems] = useState<ContentItem[] | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [status, setStatus] = useState("");
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

  useEffect(() => {
    api<ContentItem[]>(`/api/content${status ? `?status=${status}` : ""}`)
      .then(setItems)
      .catch(handleError);
  }, [status, handleError]);

  useEffect(() => {
    api<Channel[]>("/api/channels")
      .then(setChannels)
      .catch(() => {});
  }, []);

  function channelLabel(channelId: string): string {
    const ch = channels.find((c) => c.id === channelId);
    return ch ? `[${ch.platform}] ${ch.name}` : channelId;
  }

  function renderItem(item: ContentItem) {
    return (
      <li key={item.id} className="border-b border-border-soft py-3 last:border-b-0">
        <Link
          href={`/${locale}/content/${item.id}`}
          className="text-[15px] font-semibold text-fg hover:text-accent"
        >
          {item.title || t("untitled")}
        </Link>
        <ul className="mt-1.5 flex flex-col gap-1">
          {item.adaptations.map((a) => (
            <li
              key={a.id}
              className="flex flex-wrap items-center gap-1.5 text-[13px] text-fg-tertiary"
            >
              {channelLabel(a.channelId)} —{" "}
              <StatusBadge status={ADAPTATION_BADGE_STATUS[a.status]}>
                {t(`adaptationStatus.${a.status}`)}
              </StatusBadge>
              {a.status === "published" &&
                a.externalUrl &&
                (isLinkableUrl(a.externalUrl) ? (
                  <>
                    {" "}
                    <a
                      href={a.externalUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent hover:underline"
                    >
                      {a.externalUrl}
                    </a>
                  </>
                ) : (
                  <> {a.externalUrl}</>
                ))}
            </li>
          ))}
        </ul>
      </li>
    );
  }

  const groups = status
    ? [[status as ContentStatus, items ?? []] as const]
    : STATUSES.map((s) => [s, (items ?? []).filter((i) => i.status === s)] as const);

  const filterOptions = [
    { value: "", label: t("filterAll") },
    ...STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) })),
  ];

  const isEmpty = items !== null && items.length === 0;

  return (
    <AppShell
      title={t("title")}
      primaryAction={
        <Button onClick={() => router.push(`/${locale}/content/new`)}>
          <IconPlus size={16} />
          {t("newAction")}
        </Button>
      }
    >
      {error && (
        <p role="alert" className="mb-4 text-sm text-danger">
          {error}
        </p>
      )}

      <div className="mb-5">
        <p className="mb-2 text-sm font-medium text-fg-secondary">{t("filterLabel")}</p>
        <Segmented options={filterOptions} value={status} onChange={setStatus} />
      </div>

      {isEmpty && (
        <Card padded={false}>
          <EmptyState
            title={t("empty")}
            action={
              <Button size="sm" onClick={() => router.push(`/${locale}/content/new`)}>
                {t("emptyCreateAction")}
              </Button>
            }
          />
        </Card>
      )}

      {groups.map(([s, groupItems]) =>
        groupItems.length === 0 ? null : (
          <section key={s} className="mb-6">
            <h2 className="mb-2 text-sm font-semibold text-fg-secondary">{t(`status.${s}`)}</h2>
            <Card padded={false}>
              <ul className="px-4">{groupItems.map(renderItem)}</ul>
            </Card>
          </section>
        ),
      )}
    </AppShell>
  );
}
