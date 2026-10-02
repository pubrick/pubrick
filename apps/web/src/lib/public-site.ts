import type { Metadata } from "next";
import { routing } from "@/i18n/routing";

export const REPOSITORY = "https://github.com/pubrick/pubrick";
export const PUBLIC_PAGES = ["", "product", "use-cases", "open-source", "hosting", "docs"] as const;
export type PublicPage = (typeof PUBLIC_PAGES)[number];

/** Runtime configuration: the same image can serve any installation's origin. */
export function publicSiteConfig() {
  const raw = process.env.PUBLIC_ORIGIN;
  let origin: string | undefined;
  try {
    const url = new URL(raw ?? "");
    if (
      ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    )
      origin = url.origin;
  } catch {
    /* No configured origin means no invented canonical URL. */
  }
  const indexable =
    process.env.PUBLIC_SITE_INDEXING === "true" && origin?.startsWith("https://") === true;
  return { origin, indexable };
}

export function publicPath(locale: string, page: PublicPage = "") {
  return `/${locale}${page ? `/${page}` : ""}`;
}

export function publicMetadata(
  locale: string,
  page: PublicPage,
  title: string,
  description: string,
): Metadata {
  const { origin, indexable } = publicSiteConfig();
  const url = origin ? `${origin}${publicPath(locale, page)}` : undefined;
  return {
    title: `${title} | Pubrick`,
    description,
    robots: { index: indexable, follow: true },
    ...(origin
      ? {
          metadataBase: new URL(origin),
          alternates: {
            canonical: url,
            languages: Object.fromEntries([
              ...routing.locales.map((code) => [code, `${origin}${publicPath(code, page)}`]),
              ["x-default", `${origin}${publicPath("en", page)}`],
            ]),
          },
        }
      : {}),
    openGraph: {
      title,
      description,
      siteName: "Pubrick",
      type: "website",
      url,
      locale: ({ en: "en_US", ru: "ru_RU", es: "es_ES", pt: "pt_BR" } as Record<string, string>)[
        locale
      ],
      images: [
        {
          url: "/social-card.png",
          width: 1280,
          height: 640,
          alt: "Pubrick — an open-source content studio",
        },
      ],
    },
    twitter: { card: "summary_large_image", title, description, images: ["/social-card.png"] },
  };
}

export function publicStructuredData(locale: string, description: string) {
  const { origin } = publicSiteConfig();
  if (!origin) return undefined;
  return JSON.stringify({
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Pubrick",
    url: `${origin}${publicPath(locale)}`,
    description,
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    license: `${REPOSITORY}/blob/main/LICENSE`,
    isAccessibleForFree: true,
    sameAs: REPOSITORY,
  }).replace(/</g, "\\u003c");
}
