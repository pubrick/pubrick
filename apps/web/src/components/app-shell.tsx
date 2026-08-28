"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { Logo } from "@/components/Logo";
import { IconBrands, type IconProps, IconQueue, IconSettings } from "@/components/ui/icons";
import { Menu } from "@/components/ui/menu";
import { authClient } from "@/lib/auth-client";

export type AppShellProps = {
  title: string;
  primaryAction?: ReactNode;
  search?: ReactNode;
  children: ReactNode;
};

type NavKey = "queue" | "brands" | "settings";

const NAV_ICONS: Record<NavKey, (props: IconProps) => ReactNode> = {
  queue: IconQueue,
  brands: IconBrands,
  settings: IconSettings,
};

/**
 * The signed-in section's shell: 232px sidebar (>=1024px) / 60px icon rail
 * (640-1024px) / bottom tab bar (<640px). All three are ONE set of nav
 * links repositioned by breakpoint via Tailwind's responsive prefixes —
 * never three duplicated landmarks — so there is exactly one `<nav>` in the
 * accessibility tree no matter the viewport.
 *
 * Order is fixed by the UX constitution and is NOT configurable: Queue,
 * Brands, a spacer, Settings LAST, then the user block. On the mobile tab
 * row (a plain `flex` row, never reversed) "last in the DOM" is also
 * "rightmost" — so Settings lands on the right there for free, with no
 * separate mobile-only ordering logic to keep in sync.
 *
 * No Calendar, no Compose: those existed in the design canvas artboards but
 * are dead per the task brief — Compose is each page's own primary-action
 * button, not a nav destination.
 */
export function AppShell({ title, primaryAction, search, children }: AppShellProps) {
  const t = useTranslations("Nav");
  const tLanding = useTranslations("Landing");
  const locale = useLocale();
  const pathname = usePathname();
  const { data: session } = authClient.useSession();

  const destinations: { key: NavKey; href: string }[] = [
    { key: "queue", href: `/${locale}/content` },
    { key: "brands", href: `/${locale}/brands` },
  ];
  const settingsHref = `/${locale}/settings`;

  function isActive(href: string): boolean {
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  function navLinkClasses(active: boolean): string {
    return [
      "flex min-h-11 flex-col items-center justify-center gap-1 rounded-control px-2 py-1.5 text-center text-[10.5px] font-semibold transition-colors",
      "sm:min-h-0 sm:flex-row sm:justify-start sm:gap-2.5 sm:px-2.5 sm:py-2 sm:text-left sm:text-sm sm:font-medium",
      active
        ? "text-accent sm:bg-accent-soft sm:text-accent-soft-fg"
        : "text-fg-secondary hover:text-fg sm:hover:bg-bg-sunken",
    ].join(" ");
  }

  function renderLink(key: NavKey, href: string) {
    const Icon = NAV_ICONS[key];
    const active = isActive(href);
    const label = t(key);
    return (
      <Link
        key={key}
        href={href}
        title={label}
        aria-current={active ? "page" : undefined}
        className={navLinkClasses(active)}
      >
        <Icon size={20} />
        <span className="sm:hidden lg:inline">{label}</span>
      </Link>
    );
  }

  const email = session?.user?.email ?? "";
  const initial = email.charAt(0).toUpperCase();

  return (
    <div className="flex min-h-screen flex-col bg-bg text-fg sm:flex-row">
      <nav
        aria-label={t("label")}
        className="fixed inset-x-0 bottom-0 z-40 flex items-stretch justify-around gap-1 border-t border-border bg-panel px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1.5 sm:sticky sm:inset-auto sm:top-0 sm:h-screen sm:w-[60px] sm:flex-col sm:items-stretch sm:justify-start sm:gap-1 sm:border-t-0 sm:border-r sm:px-2 sm:py-4 lg:w-[232px] lg:px-3"
      >
        <div className="hidden items-center gap-2 px-2 pb-5 lg:flex">
          <Logo width={22} />
          <span className="text-[17px] font-bold tracking-tight">pubrick</span>
        </div>

        {destinations.map(({ key, href }) => renderLink(key, href))}

        {/* Grows in the sidebar/rail column to push Settings + the user
            block down; hidden (zero space) in the mobile row, where
            justify-around already spaces the three tabs evenly. */}
        <div aria-hidden="true" className="hidden sm:block sm:flex-1" />

        {renderLink("settings", settingsHref)}

        {session && (
          <div className="hidden items-center gap-2 border-t border-border px-2 pt-3 lg:flex">
            <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-fg text-[11px] font-semibold text-bg">
              {initial}
            </span>
            <Menu
              trigger={<span className="truncate text-[13px] font-medium text-fg">{email}</span>}
              items={[{ label: tLanding("signOut"), onSelect: () => authClient.signOut() }]}
            />
          </div>
        )}
      </nav>

      <div className="flex min-w-0 flex-1 flex-col pb-16 sm:pb-0">
        <header className="flex flex-wrap items-center justify-between gap-3 px-5 pt-6 pb-2 sm:px-9 sm:pt-7">
          <h1 className="m-0 text-[30px] font-bold tracking-tight sm:text-[26px]">{title}</h1>
          {(search || primaryAction) && (
            <div className="flex items-center gap-3">
              {search}
              {primaryAction}
            </div>
          )}
        </header>
        <main className="flex-1 px-5 pb-9 sm:px-9">{children}</main>
      </div>
    </div>
  );
}
