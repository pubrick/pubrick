"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { authClient } from "@/lib/auth-client";

// Mirrors Button's primary/secondary visuals on an <a> — these two links need
// to look like the design system's Buttons while staying real <Link>s (role
// "link", not "button"), which the pinned Landing tests assert on via href.
const primaryLinkClasses =
  "inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-control border border-transparent bg-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-accent-hover";
const secondaryLinkClasses =
  "inline-flex h-9 items-center justify-center gap-2 rounded-control border border-border bg-panel px-4 text-sm font-semibold text-fg transition-colors hover:bg-bg-sunken";

export default function LandingPage() {
  const t = useTranslations("Landing");
  const locale = useLocale();
  const { data: session, isPending } = authClient.useSession();

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-bg-sunken px-4">
      <h1>
        <Logo width={200} title={t("title")} />
      </h1>
      <Card
        padded={false}
        className="flex w-full max-w-[400px] flex-col items-center gap-4 p-8 text-center"
      >
        <p className="text-sm text-fg-secondary">{t("tagline")}</p>
        {isPending ? null : session ? (
          <div className="flex w-full flex-col gap-2">
            <Link href={`/${locale}/brands`} className={primaryLinkClasses}>
              {t("goToBrands")}
            </Link>
            <Link href={`/${locale}/content`} className={secondaryLinkClasses}>
              {t("goToContent")}
            </Link>
            <Button variant="ghost" className="w-full" onClick={() => authClient.signOut()}>
              {t("signOut")}
            </Button>
          </div>
        ) : (
          <div className="flex w-full gap-3">
            <Link href={`/${locale}/login`} className={`${secondaryLinkClasses} flex-1`}>
              {t("login")}
            </Link>
            <Link href={`/${locale}/signup`} className={primaryLinkClasses}>
              {t("signup")}
            </Link>
          </div>
        )}
      </Card>
    </main>
  );
}
