"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
import { scheduledPreflight } from "@/lib/scheduled-preflight";

type Props = {
  item: {
    status: string;
    body: string;
    coverMediaId: string | null;
    videoMediaId: string | null;
    adaptations: readonly {
      channelId: string;
      body: string | null;
      scheduledAt: string | null;
      status: string;
    }[];
  };
  channels: readonly { id: string; platform: string }[];
  channelLabel: (channelId: string) => string;
};

/** Saved-state diagnostics beside the schedule; this never makes a delivery decision. */
export function ScheduledPreflight({ item, channels, channelLabel }: Props) {
  const t = useTranslations("Publish.scheduledPreflight");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const rows = scheduledPreflight(item, channels, now);
  if (rows.length === 0) return null;
  const hasAttention = rows.some((row) => row.issues.some((issue) => issue !== "slot_due"));
  return (
    <Card className="mb-6">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold text-fg">{t("title")}</h2>
        <StatusBadge status={hasAttention ? "review" : "scheduled"}>
          {t(hasAttention ? "check" : "savedReady")}
        </StatusBadge>
      </div>
      <p className="text-sm text-fg-secondary">{t("intro")}</p>
      <ul className="mt-3 divide-y divide-border-soft">
        {rows.map((row) => (
          <li key={row.channelId} className="py-3 first:pt-0 last:pb-0">
            <strong className="text-sm font-semibold text-fg">{channelLabel(row.channelId)}</strong>
            <p className="text-sm text-fg-secondary">
              {row.bodyLimit === null
                ? t("bodyUnknown", { count: row.bodyLength })
                : t("bodyCount", { count: row.bodyLength, limit: row.bodyLimit })}
              {" · "}
              {t(`media.${row.media}`)}
            </p>
            {row.issues.length === 0 ? (
              <p className="text-sm text-fg-secondary">{t("scheduled")}</p>
            ) : (
              <ul className="mt-1 list-disc pl-5 text-sm text-[var(--status-review-fg)]">
                {row.issues.map((issue) => (
                  <li key={issue}>{t(`issue.${issue}`)}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-fg-tertiary">{t("limits")}</p>
    </Card>
  );
}
