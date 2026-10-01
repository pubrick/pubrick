"use client";

import { type ContentReuseAttribution, contentReuseAttributionSchema } from "@pubrick/shared";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";

export function SavedSourceAttribution({ source }: { source: ContentReuseAttribution }) {
  const t = useTranslations("Reuse");
  const locale = useLocale();
  const parsed = contentReuseAttributionSchema.safeParse(source);
  const safe = parsed.success ? parsed.data : null;
  return (
    <div
      data-testid="saved-source-attribution"
      className="mb-4 border-l-2 border-border pl-3 text-sm text-fg-secondary"
    >
      <p className="font-medium">{t("sourceLabel")}</p>
      {safe?.state === "available" ? (
        <p className="mt-1">
          <Link
            className="text-accent hover:underline"
            href={`/${locale}/content/${safe.sourceContentId}`}
          >
            {safe.title?.trim() ? safe.title : t("untitled")}
          </Link>
          {" · "}
          {t("revision", { revision: safe.sourceRevision })}
        </p>
      ) : (
        <p className="mt-1">{t(safe?.state === "redacted" ? "redacted" : "unavailable")}</p>
      )}
    </div>
  );
}
