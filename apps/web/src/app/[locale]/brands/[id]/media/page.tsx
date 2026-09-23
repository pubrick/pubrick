"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { use } from "react";
import { AppShell } from "@/components/app-shell";
import { MediaLibrary } from "@/components/media-library";
import { buttonClasses } from "@/components/ui/button";

export default function BrandMediaPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const locale = useLocale();
  const t = useTranslations("Media");
  return (
    <AppShell
      title={t("title")}
      primaryAction={
        <label htmlFor="brand-media-upload" className={buttonClasses()}>
          {t("add")}
        </label>
      }
    >
      <Link href={`/${locale}/brands/${id}`} className="text-sm text-fg-secondary underline">
        {t("back")}
      </Link>
      <MediaLibrary brandId={id} uploadInputId="brand-media-upload" showUploadButton={false} />
    </AppShell>
  );
}
