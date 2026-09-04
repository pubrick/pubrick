"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Logo } from "@/components/Logo";
import { IconBrands, type IconProps, IconQueue, IconSettings } from "@/components/ui/icons";
import { Menu } from "@/components/ui/menu";
import { ToastProvider } from "@/components/ui/toast";
import { TRANSITION_COLORS } from "@/components/ui/transition";
import { useSignOut } from "@/hooks/use-sign-out";
import { authClient } from "@/lib/auth-client";
import { loginHref } from "@/lib/auth-routes";
import { onUnauthorized } from "@/lib/unauthorized";

export type AppShellProps = {
  // ReactNode (not just string) so a page can show e.g. a `Skeleton` in the
  // title slot while the real title is still loading.
  title: ReactNode;
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
 *
 * The shell is also the auth guard for everything it wraps. No route under it
 * has one of its own, so a signed-out visitor used to get the whole screen —
 * nav, filters, whatever the page had already painted — with an inline error
 * where the data should be. Once the session resolves to null the shell
 * renders NOTHING and sends the visitor to the login screen with the path they
 * wanted, so that logging in returns them to it.
 *
 * What returning nothing does and does not buy, stated exactly, because the
 * comment here used to overclaim it: it keeps the chrome, the title and every
 * CHILD component off the screen and unmounted, so nothing under it fetches,
 * and no 401 is ever painted. It does NOT stop the page's own requests. Every
 * screen in this app renders the shell from the same component that does its
 * fetching — the queue's content and runs polls, the item screen's read
 * receipt — so those are already in flight by the time this guard has an
 * opinion, and no guard living inside the shell could be otherwise. That is
 * not a hole to plug here: those requests answer 401 to a signed-out visitor,
 * which is what a session-less request should do, and the 401 is now the thing
 * that carries the reader to the login screen (see the expiry effect below).
 * The guard's job is that nobody is left LOOKING at the result.
 */
export function AppShell({ title, primaryAction, search, children }: AppShellProps) {
  const t = useTranslations("Nav");
  const tLanding = useTranslations("Landing");
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const signOut = useSignOut();
  const { data: session, isPending, refetch } = authClient.useSession();

  /**
   * Before telling anyone they are signed out, ask the server.
   *
   * better-auth's session store is a module-level singleton shared with
   * whatever screen we arrived from, and the login screen subscribes nothing to
   * it — so the `null` it settled on BEFORE the visitor signed in is still
   * sitting there when this shell mounts, and the library's own re-check is
   * only scheduled for the next tick. Judging that value bounces a person who
   * has *just logged in* straight back to the login screen; it was reproduced
   * in a browser before this confirmation existed, and no jsdom test would have
   * shown it, because the race is between two real timers.
   *
   * So a suspected sign-out costs one `get-session` round trip, and only a null
   * that survives it is a verdict. `isPending` is checked first for the
   * ordinary cold load, where the store has not answered even once yet;
   * `confirming` keeps StrictMode's double-invoked effect from asking twice.
   */
  const [confirmedSignedOut, setConfirmedSignedOut] = useState(false);
  const confirming = useRef(false);

  /**
   * ...and the other direction: a session that dies while nobody navigates.
   *
   * The store above is refreshed on mount, on `visibilitychange` and on
   * `online`, and on nothing else — no refetch interval is configured, and
   * better-auth is never told that an API request came back 401. So on the two
   * screens that poll while a delivery is in flight, watched by the very
   * person the polling was built for, not one of those events fires: the poll
   * stops on the 4xx, an alert goes red, and the guard above never hears that
   * there is nothing left to guard. That was a fully painted screen with no
   * redirect and no link out of it until its owner switched tabs.
   *
   * A 401 is the SERVER's verdict on the session, not the store's stale copy
   * of one, so it needs no confirming round trip the way a suspected sign-out
   * does — it already is the round trip. `refetch()` still goes out, not to
   * decide anything here, but so that the store the rest of the app reads
   * (the login screen we are about to land on included) stops reporting a user
   * the API has stopped accepting.
   *
   * One way, once. The queue runs TWO polls — its cards and its open runs —
   * and a session that has ended ends both of them, usually in the same tick;
   * `left` is what keeps that one event from being two departures.
   */
  const [expired, setExpired] = useState(false);
  const left = useRef(false);

  useEffect(
    () =>
      onUnauthorized(() => {
        if (left.current) return;
        left.current = true;
        setExpired(true);
        void refetch();
        router.replace(loginHref(locale, pathname));
      }),
    [refetch, router, locale, pathname],
  );

  useEffect(() => {
    // The expiry above owns the departure once it has happened; re-confirming
    // a sign-out the server has already stated would only spend a second
    // `get-session` on the way out.
    if (expired) return;
    if (session) {
      // Signed in again (or never really out): forget the old verdict, so a
      // later expiry is re-confirmed rather than inheriting this one.
      setConfirmedSignedOut(false);
      return;
    }
    if (isPending) return;
    if (confirmedSignedOut) {
      router.replace(loginHref(locale, pathname));
      return;
    }
    if (confirming.current) return;
    confirming.current = true;
    // `refetch` resolves only after the store has been written with the
    // server's answer, so the state this effect re-runs on is that answer.
    void refetch().finally(() => {
      confirming.current = false;
      setConfirmedSignedOut(true);
    });
  }, [expired, session, isPending, confirmedSignedOut, refetch, router, locale, pathname]);

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
      `flex min-h-11 flex-col items-center justify-center gap-1 rounded-control px-2 py-1.5 text-center text-[10.5px] font-semibold ${TRANSITION_COLORS}`,
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

  // Nothing — not the chrome, not the title, not a "redirecting…" line — until
  // there is a session to render it for. The effects above are already on the
  // way to the login screen.
  //
  // `expired` is checked as well as `session`, and that is the point of it:
  // the store still holds a user at this moment (nothing has told it
  // otherwise), so reading `session` alone would keep the dead screen — and
  // its red alert — painted underneath a navigation that has not landed yet.
  if (expired || !session) return null;

  return (
    <ToastProvider>
      <div className="flex min-h-screen flex-col bg-bg text-fg sm:flex-row">
        <nav
          aria-label={t("label")}
          className="fixed inset-x-0 bottom-0 z-40 flex items-stretch justify-around gap-1 border-t border-border bg-panel px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1.5 sm:sticky sm:inset-auto sm:top-0 sm:h-screen sm:w-[60px] sm:flex-col sm:items-stretch sm:justify-start sm:gap-1 sm:border-t-0 sm:border-r sm:px-2 sm:py-4 lg:w-[232px] lg:px-3"
        >
          {/* The logo IS the wordmark — it spells "pubrick" — so a text label
              beside it prints the name twice. It carries its own accessible
              name, which is why nothing here is announced to a screen reader
              in its place. */}
          <div className="hidden items-center px-2 pb-5 lg:flex">
            <Logo width={104} />
          </div>

          {destinations.map(({ key, href }) => renderLink(key, href))}

          {/* Grows in the sidebar/rail column to push Settings + the user
              block down; hidden (zero space) in the mobile row, where
              justify-around already spaces the three tabs evenly. */}
          <div aria-hidden="true" className="hidden sm:block sm:flex-1" />

          {renderLink("settings", settingsHref)}

          <div className="hidden items-center gap-2 border-t border-border px-2 pt-3 lg:flex">
            <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-fg text-[11px] font-semibold text-bg">
              {initial}
            </span>
            <Menu
              trigger={<span className="truncate text-[13px] font-medium text-fg">{email}</span>}
              items={[{ label: tLanding("signOut"), onSelect: () => void signOut() }]}
            />
          </div>
        </nav>

        <div className="flex min-w-0 flex-1 flex-col pb-16 sm:pb-0">
          <header className="flex flex-wrap items-center justify-between gap-3 px-5 pt-6 pb-2 sm:px-9 sm:pt-7">
            <h1 className="m-0 text-[30px] font-bold tracking-tight sm:text-[26px]">{title}</h1>
            {(search || primaryAction) && (
              <div className="flex items-center gap-3">
                {search}
                {/* Design-system spec §3: touch targets ≥44px below 640px. Button's own `md`/`sm`
                    sizes are 36px/30px tall — min-height (not height) is what a
                    descendant selector can add without fighting Button's own `h-*`
                    utility, since min-height always clamps the box's used height
                    regardless of a smaller explicit `height` elsewhere in the
                    cascade. Reset to min-h-0 at sm+ so desktop/rail sizing (the
                    Button's own height) is unchanged — `min-h-11` mirrors the same
                    44px token the mobile nav links already use above. Text labels
                    stay: this slot holds one verb-labelled button (the item
                    screen's "Publish now"; Reject moved down to the decision card
                    when the constitution's one-primary-action rule was applied),
                    and a round icon-only button would be cryptic — a deliberate
                    deviation from the spec's "round" 44px mobile primary-action
                    wording. The gap and the flex row remain because the slot takes
                    an arbitrary node and a screen may still pass more than one. */}
                {primaryAction && (
                  <div className="flex items-center gap-2 [&_button]:min-h-11 sm:[&_button]:min-h-0">
                    {primaryAction}
                  </div>
                )}
              </div>
            )}
          </header>
          <main className="flex-1 px-5 pb-9 sm:px-9">{children}</main>
        </div>
      </div>
    </ToastProvider>
  );
}
