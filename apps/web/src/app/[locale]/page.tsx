"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { Logo } from "@/components/Logo";
import { authClient } from "@/lib/auth-client";

export default function LandingPage() {
  const t = useTranslations("Landing");
  const locale = useLocale();
  const { data: session, isPending } = authClient.useSession();

  return (
    <main style={{ fontFamily: "system-ui", padding: "4rem", maxWidth: 640 }}>
      <h1 style={{ margin: "0 0 1rem" }}>
        <Logo width={280} title={t("title")} />
      </h1>
      <p>{t("tagline")}</p>
      {isPending ? null : session ? (
        <p>
          <Link href={`/${locale}/brands`}>{t("goToBrands")}</Link>{" "}
          <button type="button" onClick={() => authClient.signOut()}>
            {t("signOut")}
          </button>
        </p>
      ) : (
        <p>
          <Link href={`/${locale}/login`}>{t("login")}</Link> ·{" "}
          <Link href={`/${locale}/signup`}>{t("signup")}</Link>
        </p>
      )}
    </main>
  );
}
