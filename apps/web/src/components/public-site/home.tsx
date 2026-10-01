import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { buttonClasses } from "@/components/ui/button";
import { publicPath, publicStructuredData, REPOSITORY } from "@/lib/public-site";
import { EditorExample } from "./editor-example";
import { PublicShell } from "./shell";

export async function PublicHome({ locale }: { locale: string }) {
  const t = await getTranslations({ locale, namespace: "Marketing" });
  const schema = publicStructuredData(locale, t("home.description"));
  return (
    <PublicShell locale={locale}>
      {schema ? (
        <script
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted localized data, serialized with HTML less-than escaped
          dangerouslySetInnerHTML={{ __html: schema }}
        />
      ) : null}
      <section className="public-container public-hero">
        <div className="max-w-3xl">
          <p className="public-eyebrow">{t("home.eyebrow")}</p>
          <h1 className="public-title mt-7">{t("home.title")}</h1>
          <p className="public-lead mt-7 max-w-xl">{t("home.description")}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href={publicPath(locale, "product")}
              className={buttonClasses("primary", "md", "min-h-12 px-6")}
            >
              {t("learn")}
            </Link>
            <Link
              href={publicPath(locale, "open-source")}
              className={buttonClasses("secondary", "md", "min-h-12 px-6")}
            >
              {t("nav.openSource")}
            </Link>
          </div>
          <p className="mt-5 text-sm text-fg-secondary">{t("home.note")}</p>
        </div>
        <EditorExample key={locale} />
      </section>
      <section className="border-y border-border bg-bg-sunken">
        <div className="public-container py-16 sm:py-24">
          <div className="max-w-2xl">
            <p className="public-eyebrow">Pubrick / {t("studioNotes")}</p>
            <h2 className="public-heading mt-5">{t("home.principlesTitle")}</h2>
            <p className="public-lead mt-5">{t("home.principlesBody")}</p>
          </div>
          <div className="mt-12 max-w-4xl divide-y divide-border">
            {([1, 2, 3] as const).map((n) => (
              <div key={n} className="grid gap-4 py-7 sm:grid-cols-[3rem_1fr_1.5fr]">
                <span aria-hidden="true" className="font-mono text-sm text-accent">
                  0{n}
                </span>
                <h3 className="text-xl font-semibold">{t(`home.feature${n}Title`)}</h3>
                <p className="leading-relaxed text-fg-secondary">{t(`home.feature${n}Body`)}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
      <section className="public-container py-20 sm:py-28">
        <p className="public-statement max-w-4xl">{t("home.statement")}</p>
        <p className="public-lead mt-6 max-w-xl">{t("home.statementBody")}</p>
        <Link
          href={publicPath(locale, "use-cases")}
          className="mt-6 inline-flex min-h-11 items-center font-medium text-accent underline underline-offset-4"
        >
          {t("nav.useCases")}{" "}
          <span aria-hidden="true" className="ml-2">
            ↗
          </span>
        </Link>
      </section>
      <section className="border-t border-border">
        <div className="public-container py-16 sm:py-24">
          <h2 className="public-heading max-w-2xl">{t("home.pathsTitle")}</h2>
          <p className="public-lead mt-5 max-w-2xl">{t("home.pathsBody")}</p>
          <div className="mt-10 grid gap-6 md:grid-cols-2">
            {(["self", "hosted"] as const).map((kind) => (
              <div
                key={kind}
                className="rounded-panel border border-border bg-bg-sunken p-7 sm:p-10"
              >
                <p className="public-eyebrow">
                  {t(kind === "self" ? "selfHostedStatus" : "hostedStatus")}
                </p>
                <h3 className="mt-5 text-2xl font-semibold tracking-tight">
                  {t(`home.${kind}Title`)}
                </h3>
                <p className="mt-4 leading-relaxed text-fg-secondary">{t(`home.${kind}Body`)}</p>
                <Link
                  href={publicPath(locale, kind === "self" ? "open-source" : "hosting")}
                  className="mt-6 inline-flex min-h-11 items-center font-medium text-accent underline underline-offset-4"
                >
                  {t(kind === "self" ? "install" : "nav.hosting")}
                </Link>
              </div>
            ))}
          </div>
        </div>
      </section>
      <section className="public-container py-16 sm:py-24">
        <h2 className="public-heading max-w-3xl">{t("home.ctaTitle")}</h2>
        <p className="public-lead mt-5">{t("home.ctaBody")}</p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            href={publicPath(locale, "docs")}
            className={buttonClasses("primary", "md", "min-h-12 px-6")}
          >
            {t("nav.docs")}
          </Link>
          <a href={REPOSITORY} className={buttonClasses("secondary", "md", "min-h-12 px-6")}>
            {t("github")}
          </a>
        </div>
      </section>
    </PublicShell>
  );
}
