import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { buttonClasses } from "@/components/ui/button";
import { type PublicPage, publicPath, REPOSITORY } from "@/lib/public-site";
import { PublicShell } from "./shell";

export const DOC_LINKS = [
  ["setup", "docs/self-hosting.md"],
  ["providers", "docs/llm-providers.md"],
  ["channels", "docs/publication-operations.md"],
  ["workflow", "docs/porting-status.md"],
  ["architecture", "docs/architecture.md"],
  ["api", "docs/public-api.md"],
  ["contributing", "CONTRIBUTING.md"],
  ["roadmap", "docs/roadmap.md"],
] as const;

export function pageCopyKey(page: Exclude<PublicPage, "">) {
  return page === "use-cases" ? "useCases" : page;
}

export async function PublicDetail({
  locale,
  page,
}: {
  locale: string;
  page: Exclude<PublicPage, "">;
}) {
  const t = await getTranslations({ locale, namespace: "Marketing" });
  const key = pageCopyKey(page);
  return (
    <PublicShell locale={locale} page={page}>
      <section className="public-container py-16 sm:py-24">
        <p className="public-eyebrow">{t(`${key}.eyebrow`)}</p>
        <h1 className="public-title mt-7 max-w-4xl">{t(`${key}.title`)}</h1>
        <p className="public-lead mt-7 max-w-2xl">{t(`${key}.description`)}</p>
      </section>
      <section className="border-y border-border bg-bg-sunken">
        <div className="public-container grid gap-12 py-16 sm:py-24 lg:grid-cols-[1fr_18rem]">
          <div className="space-y-12">
            {([1, 2, 3] as const).map((n) => (
              <section key={n} className="grid gap-4 sm:grid-cols-[3rem_1fr]">
                <span aria-hidden="true" className="font-mono text-sm text-accent">
                  0{n}
                </span>
                <div>
                  <h2 className="text-2xl font-semibold tracking-tight">
                    {t(`${key}.section${n}Title`)}
                  </h2>
                  <p className="mt-4 max-w-2xl text-lg leading-relaxed text-fg-secondary">
                    {t(`${key}.section${n}Body`)}
                  </p>
                </div>
              </section>
            ))}
          </div>
          <aside className="self-start rounded-panel border border-border bg-panel p-7">
            <h2 className="text-lg font-semibold">{t(`${key}.asideTitle`)}</h2>
            <p className="mt-4 text-sm leading-relaxed text-fg-secondary">
              {t(`${key}.asideBody`)}
            </p>
            <Link
              href={publicPath(locale, page === "docs" ? "product" : "docs")}
              className="mt-5 inline-flex min-h-11 items-center font-medium text-accent underline underline-offset-4"
            >
              {t(page === "docs" ? "nav.product" : "nav.docs")}
            </Link>
          </aside>
        </div>
      </section>
      {page === "docs" || page === "open-source" ? (
        <section className="public-container grid gap-4 py-16 sm:grid-cols-2 lg:grid-cols-4">
          {DOC_LINKS.map(([label, path]) => (
            <a
              key={path}
              href={`${REPOSITORY}/blob/main/${path}`}
              className="flex min-h-24 items-center justify-between gap-4 rounded-panel border border-border p-5 font-medium transition-colors hover:bg-bg-sunken"
            >
              {t(`links.${label}`)}
              <span aria-hidden="true">↗</span>
            </a>
          ))}
        </section>
      ) : null}
      <section className="public-container py-16 sm:py-24">
        <h2 className="public-heading max-w-3xl">{t(`${key}.ctaTitle`)}</h2>
        <p className="public-lead mt-5 max-w-2xl">{t(`${key}.ctaBody`)}</p>
        <div className="mt-8 flex flex-wrap gap-3">
          <a
            href={`${REPOSITORY}/blob/main/docs/self-hosting.md`}
            className={buttonClasses("primary", "md", "min-h-12 px-6")}
          >
            {t("install")}
          </a>
          <a href={REPOSITORY} className={buttonClasses("secondary", "md", "min-h-12 px-6")}>
            {t("github")}
          </a>
        </div>
      </section>
    </PublicShell>
  );
}
