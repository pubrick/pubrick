import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Logo } from "@/components/Logo";
import { routing } from "@/i18n/routing";
import { PUBLIC_PAGES, type PublicPage, publicPath, REPOSITORY } from "@/lib/public-site";
import { PublicAuthActions } from "./auth-actions";

const navKeys = {
  product: "product",
  "use-cases": "useCases",
  "open-source": "openSource",
  hosting: "hosting",
  docs: "docs",
} as const;
const languageNames = { en: "English", ru: "Русский", es: "Español", pt: "Português" };

export async function PublicShell({
  locale,
  page = "",
  children,
}: {
  locale: string;
  page?: PublicPage;
  children: React.ReactNode;
}) {
  const t = await getTranslations({ locale, namespace: "Marketing" });
  const landing = await getTranslations({ locale, namespace: "Landing" });
  return (
    <div className="public-site min-h-dvh bg-bg text-fg">
      <a href="#main" className="public-skip">
        {t("skip")}
      </a>
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-8 gap-y-3 px-5 py-5 sm:px-8">
          <Link
            href={publicPath(locale)}
            aria-label="Pubrick"
            className="inline-flex min-h-11 items-center"
          >
            <Logo width={140} />
          </Link>
          <nav
            aria-label={t("navLabel")}
            className="order-3 flex w-full flex-wrap gap-x-5 gap-y-1 lg:order-none lg:w-auto"
          >
            {PUBLIC_PAGES.filter((path) => path !== "").map((path) => (
              <Link
                key={path}
                href={publicPath(locale, path)}
                aria-current={page === path ? "page" : undefined}
                className="inline-flex min-h-11 items-center text-sm text-fg-secondary hover:text-fg aria-[current=page]:text-accent"
              >
                {t(`nav.${navKeys[path]}`)}
              </Link>
            ))}
          </nav>
          <PublicAuthActions />
        </div>
      </header>
      <main id="main" tabIndex={-1} className="outline-none">
        {children}
      </main>
      <footer className="border-t border-border bg-bg-sunken">
        <div className="mx-auto grid max-w-7xl gap-8 px-5 py-12 sm:px-8 md:grid-cols-[1fr_auto]">
          <div>
            <Logo width={120} />
            <p className="mt-4 max-w-sm text-lg font-medium">{t("footerLine")}</p>
            <p className="mt-3 text-sm text-fg-secondary">
              {t("license")} {t("footerNote")}
            </p>
          </div>
          <div className="flex flex-wrap items-start gap-x-8 gap-y-3 text-sm">
            <a className="inline-flex min-h-11 items-center" href={REPOSITORY}>
              {t("github")}
            </a>
            <a
              className="inline-flex min-h-11 items-center"
              href={`${REPOSITORY}/blob/main/docs/self-hosting.md`}
            >
              {landing("installGuide")}
            </a>
            <a className="inline-flex min-h-11 items-center" href={`${REPOSITORY}/security/policy`}>
              {t("links.security")}
            </a>
          </div>
          <nav aria-label={t("languages")} className="flex flex-wrap gap-2 md:col-span-2">
            {routing.locales.map((code) => (
              <Link
                key={code}
                href={publicPath(code, page)}
                lang={code}
                hrefLang={code}
                aria-current={locale === code ? "page" : undefined}
                className="inline-flex min-h-11 items-center rounded-control px-3 text-sm text-fg-secondary hover:bg-panel aria-[current=page]:font-semibold aria-[current=page]:text-fg"
              >
                {languageNames[code]}
              </Link>
            ))}
          </nav>
        </div>
      </footer>
    </div>
  );
}
