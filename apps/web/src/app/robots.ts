import type { MetadataRoute } from "next";
import { routing } from "@/i18n/routing";
import { PUBLIC_PAGES, publicPath, publicSiteConfig } from "@/lib/public-site";

export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  const { origin, indexable } = publicSiteConfig();
  return {
    rules: {
      userAgent: "*",
      disallow: "/",
      ...(indexable
        ? {
            allow: [
              "/$",
              "/_next/static/",
              "/social-card.png",
              "/icons/",
              ...PUBLIC_PAGES.flatMap((page) =>
                routing.locales.map((locale) => `${publicPath(locale, page)}$`),
              ),
            ],
          }
        : {}),
    },
    ...(indexable && origin ? { sitemap: `${origin}/sitemap.xml` } : {}),
  };
}
