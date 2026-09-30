"use client";

import { useTranslations } from "next-intl";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export function WorkspaceDataCard() {
  const t = useTranslations("SettingsPage");
  return (
    <Card>
      <h2 className="mb-1 text-base font-semibold text-fg">{t("dataTitle")}</h2>
      <p className="mb-3 text-sm text-fg-secondary">{t("dataExportHint")}</p>
      <a
        href="/api/workspace-data/export"
        target="_blank"
        rel="noopener noreferrer"
        className={buttonClasses("secondary")}
        aria-label={t("dataExportLabel")}
      >
        {t("dataExport")}
      </a>
    </Card>
  );
}
