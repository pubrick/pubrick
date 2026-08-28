"use client";

import { useTranslations } from "next-intl";
import type { OriginBadgeKind } from "@/lib/origin";

/**
 * Who wrote this post — a deliberately NEUTRAL chip.
 *
 * Provenance is not a status, and the constitution's five status colors are for
 * statuses. Painting "AI-drafted" in one of them would either invent a sixth
 * meaning for an existing color or start the drift towards a sixth color; the
 * chip therefore reads as a label, next to (never instead of) the status badge.
 */
export function OriginBadge({ origin }: { origin: OriginBadgeKind }) {
  const t = useTranslations("Content");
  return (
    <span className="inline-flex items-center rounded-chip border border-border px-2 py-0.5 text-[11px] font-semibold text-fg-tertiary">
      {t(`origin.${origin}`)}
    </span>
  );
}
