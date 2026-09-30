"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { Logo } from "@/components/Logo";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useSignOut } from "@/hooks/use-sign-out";
import { authClient } from "@/lib/auth-client";

const repository = "https://github.com/pubrick/pubrick";

export default function LandingPage() {
  const t = useTranslations("Landing");
  const locale = useLocale();
  const { data: session, isPending } = authClient.useSession();
  const signOut = useSignOut();

  return (
    <div className="min-h-dvh bg-bg text-fg">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:z-10 focus:bg-panel focus:p-4"
      >
        {t("skipToContent")}
      </a>
      <header className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-5 py-6 sm:px-8">
        <Logo width={140} title={t("title")} />
        <nav aria-label={t("navigation")} className="flex flex-wrap items-center gap-2 text-sm">
          <a
            href="#workflow"
            className="inline-flex min-h-11 items-center px-3 text-fg-secondary hover:text-fg"
          >
            {t("howItWorks")}
          </a>
          <a
            href="#hosting"
            className="inline-flex min-h-11 items-center px-3 text-fg-secondary hover:text-fg"
          >
            {t("hosting")}
          </a>
          <a
            href={repository}
            className="inline-flex min-h-11 items-center px-3 text-fg-secondary hover:text-fg"
          >
            GitHub
          </a>
        </nav>
      </header>
      <main id="main" className="mx-auto max-w-6xl px-5 pb-16 sm:px-8 sm:pb-24">
        <section
          className="grid gap-10 py-12 sm:py-20 lg:grid-cols-[1.2fr_1fr] lg:items-center lg:gap-16"
          aria-labelledby="hero-title"
        >
          <div>
            <p className="mb-5 text-sm font-semibold text-accent">{t("eyebrow")}</p>
            <h1
              id="hero-title"
              className="max-w-2xl text-4xl font-semibold leading-tight tracking-tight text-balance sm:text-5xl"
            >
              {t("headline")}
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-fg-secondary">
              {t("tagline")}
            </p>
            <div className="mt-8 flex min-h-11 flex-wrap items-center gap-3">
              {isPending ? null : session ? (
                <>
                  <Link
                    href={`/${locale}/brands`}
                    className={buttonClasses("primary", "md", "min-h-11")}
                  >
                    {t("goToBrands")}
                  </Link>
                  <Link
                    href={`/${locale}/content`}
                    className={buttonClasses("secondary", "md", "min-h-11")}
                  >
                    {t("goToContent")}
                  </Link>
                  <Button variant="ghost" className="min-h-11" onClick={() => void signOut()}>
                    {t("signOut")}
                  </Button>
                </>
              ) : (
                <>
                  <Link
                    href={`/${locale}/signup`}
                    className={buttonClasses("primary", "md", "min-h-11")}
                  >
                    {t("signup")}
                  </Link>
                  <Link
                    href={`/${locale}/login`}
                    className={buttonClasses("secondary", "md", "min-h-11")}
                  >
                    {t("login")}
                  </Link>
                </>
              )}
            </div>
            <p className="mt-4 text-sm text-fg-secondary">{t("ownKeys")}</p>
          </div>
          <Card className="p-6 sm:p-8">
            <p className="mb-6 text-sm font-semibold text-fg-secondary">{t("workflowPreview")}</p>
            <ol className="space-y-6">
              {(["sources", "drafts", "review"] as const).map((step, index) => (
                <li key={step} className="flex gap-4">
                  <span
                    aria-hidden="true"
                    className="flex size-9 shrink-0 items-center justify-center rounded-control bg-accent-soft font-semibold text-accent-soft-fg"
                  >
                    {index + 1}
                  </span>
                  <div>
                    <h2 className="font-semibold">{t(`${step}Title`)}</h2>
                    <p className="mt-1 text-sm leading-relaxed text-fg-secondary">
                      {t(`${step}Description`)}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </Card>
        </section>
        <section
          id="workflow"
          className="scroll-mt-6 border-t border-border py-12 sm:py-16"
          aria-labelledby="workflow-title"
        >
          <h2 id="workflow-title" className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {t("workflowHeading")}
          </h2>
          <div className="mt-8 grid gap-8 sm:grid-cols-3">
            {(["brand", "team", "control"] as const).map((feature) => (
              <div key={feature}>
                <h3 className="text-lg font-semibold">{t(`${feature}Title`)}</h3>
                <p className="mt-3 leading-relaxed text-fg-secondary">
                  {t(`${feature}Description`)}
                </p>
              </div>
            ))}
          </div>
        </section>
        <section
          id="hosting"
          className="scroll-mt-6 border-t border-border pt-12 sm:pt-16"
          aria-labelledby="hosting-title"
        >
          <h2 id="hosting-title" className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {t("hostingHeading")}
          </h2>
          <div className="mt-8 grid gap-5 md:grid-cols-2">
            <Card className="flex flex-col items-start gap-4 p-6 sm:p-8">
              <p className="text-sm font-semibold text-fg-secondary">{t("selfHostedLabel")}</p>
              <h3 className="text-2xl font-semibold">{t("selfHostedTitle")}</h3>
              <p className="flex-1 leading-relaxed text-fg-secondary">
                {t("selfHostedDescription")}
              </p>
              <a
                href={`${repository}/blob/main/docs/self-hosting.md`}
                className={buttonClasses("secondary", "md", "min-h-11")}
              >
                {t("installGuide")}
              </a>
            </Card>
            <Card className="flex flex-col items-start gap-4 p-6 sm:p-8">
              <p className="text-sm font-semibold text-fg-secondary">{t("hostedLabel")}</p>
              <h3 className="text-2xl font-semibold">{t("hostedTitle")}</h3>
              <p className="flex-1 leading-relaxed text-fg-secondary">{t("hostedDescription")}</p>
              <a
                href={`${repository}/blob/main/docs/roadmap.md`}
                className={buttonClasses("secondary", "md", "min-h-11")}
              >
                {t("viewRoadmap")}
              </a>
            </Card>
          </div>
        </section>
      </main>
      <footer className="border-t border-border bg-bg-sunken">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-5 px-5 py-6 text-sm text-fg-secondary sm:px-8">
          <p>{t("openSource")}</p>
          <nav aria-label={t("languages")} className="flex flex-wrap gap-1">
            {(
              [
                ["en", "English"],
                ["ru", "Русский"],
                ["es", "Español"],
                ["pt", "Português"],
              ] as const
            ).map(([code, name]) => (
              <Link
                key={code}
                href={`/${code}`}
                lang={code}
                hrefLang={code}
                aria-current={locale === code ? "page" : undefined}
                className="inline-flex min-h-11 items-center rounded-control px-3 hover:bg-panel aria-[current=page]:font-semibold aria-[current=page]:text-fg"
              >
                {name}
              </Link>
            ))}
          </nav>
        </div>
      </footer>
    </div>
  );
}
