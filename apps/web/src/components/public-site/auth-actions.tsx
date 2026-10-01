"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { Button, buttonClasses } from "@/components/ui/button";
import { useSignOut } from "@/hooks/use-sign-out";
import { authClient } from "@/lib/auth-client";

export function PublicAuthActions() {
  const locale = useLocale();
  const t = useTranslations("Landing");
  const { data: session, isPending } = authClient.useSession();
  const signOut = useSignOut();
  if (isPending) return <div className="min-h-11 w-full sm:w-52" />;
  if (session)
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/${locale}/brands`} className={buttonClasses("secondary", "md", "min-h-11")}>
          {t("goToBrands")}
        </Link>
        <Link href={`/${locale}/content`} className={buttonClasses("ghost", "md", "min-h-11")}>
          {t("goToContent")}
        </Link>
        <Button variant="ghost" className="min-h-11" onClick={() => void signOut()}>
          {t("signOut")}
        </Button>
      </div>
    );
  return (
    <div className="flex items-center gap-2">
      <Link href={`/${locale}/login`} className={buttonClasses("ghost", "md", "min-h-11")}>
        {t("login")}
      </Link>
      <Link href={`/${locale}/signup`} className={buttonClasses("primary", "md", "min-h-11")}>
        {t("signup")}
      </Link>
    </div>
  );
}
