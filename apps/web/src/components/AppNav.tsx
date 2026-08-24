"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";

/**
 * The signed-in section's navigation.
 *
 * Small on purpose, but not optional: until it existed, `/content` — the whole
 * review-and-publish flow — was reachable only by typing the URL. Nothing in
 * the UI linked to it.
 */
export function AppNav({ current }: { current: "brands" | "content" }) {
  const t = useTranslations("Nav");
  const locale = useLocale();

  const links = [
    { key: "brands" as const, href: `/${locale}/brands` },
    { key: "content" as const, href: `/${locale}/content` },
  ];

  return (
    <nav aria-label={t("label")} style={{ marginBottom: "1.5rem" }}>
      {links.map((link, index) => (
        <span key={link.key}>
          {index > 0 && " · "}
          {link.key === current ? (
            <strong aria-current="page">{t(link.key)}</strong>
          ) : (
            <Link href={link.href}>{t(link.key)}</Link>
          )}
        </span>
      ))}
    </nav>
  );
}
