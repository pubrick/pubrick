import type { MetadataRoute } from "next";
import { routing } from "@/i18n/routing";
import { PUBLIC_PAGES, publicPath, publicSiteConfig } from "@/lib/public-site";

export const dynamic = "force-dynamic";

export default function sitemap(): MetadataRoute.Sitemap {
  const { origin, indexable } = publicSiteConfig();
  if (!origin || !indexable) return [];
  return PUBLIC_PAGES.flatMap((page) =>
    routing.locales.map((locale) => ({
      url: `${origin}${publicPath(locale, page)}`,
      alternates: {
        languages: Object.fromEntries([
          ...routing.locales.map((code) => [code, `${origin}${publicPath(code, page)}`]),
          ["x-default", `${origin}${publicPath("en", page)}`],
        ]),
      },
    })),
  );
}
