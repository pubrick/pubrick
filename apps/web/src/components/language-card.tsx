"use client";

import { usePathname, useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Modal } from "@/components/ui/modal";
import { Segmented } from "@/components/ui/segmented";
import { localeOptions, localeSwitchHref, rememberLocale } from "@/lib/locale";

/**
 * The language this switcher has just asked the router for, or `null`.
 *
 * Module scope, because that is exactly the lifetime it needs: a locale switch
 * is a SOFT navigation, so the JavaScript realm survives it while the React
 * tree does not. It is read once by the card that comes back and cleared in the
 * same breath, so nothing can be left armed to steal focus later.
 */
let switchedTo: string | null = null;

function takeSwitch(): string | null {
  const value = switchedTo;
  switchedTo = null;
  return value;
}

export type LanguageCardProps = {
  /**
   * Whether the screen around this card is holding text nobody has saved.
   *
   * Switching language is a navigation, so anything the current screen holds in
   * memory goes with it. On Settings — the card's one place — that is the
   * credential form, and a typed API key is unrecoverable: no endpoint returns
   * one, so the reader would have to go back to the provider for another.
   * Defaults to `false`; a screen with nothing to lose gets no dialog.
   */
  hasUnsavedText?: boolean;
};

/**
 * The language preference, in the shape the theme preference already has.
 *
 * The UX constitution's one-place rule puts a setting at exactly one fixed
 * location, and for a small mutually-exclusive choice the canonical control is
 * `Segmented`. Appearance is the precedent this follows literally — a `Card`, a
 * heading, a pill strip — because a second preference of the same kind that
 * looked different would be a new pattern for no reason. The keyboard model
 * (one tab stop, arrows to move, Home/End) comes with the control, so this one
 * answers the same keys the theme strip does.
 *
 * What is NOT shared with the theme is where the choice is kept and what
 * applying it costs. A theme is an attribute on `<html>`; a locale is a path
 * segment, so choosing one navigates. Four consequences, decided here rather
 * than discovered:
 *
 * - **History.** `replace`, never `push`. A preference is not a place you
 *   travelled to, and a Back press out of Settings should return the reader to
 *   where they came from — not to this same screen in the language they have
 *   just rejected, which would read as the switch having failed.
 * - **Work in flight.** Choosing the language already in use does nothing at
 *   all. `router.replace` to the URL you are already on still tears the tree
 *   down and rebuilds it, cancelling anything the page has running — the
 *   queue's poll, a request mid-flight — to arrive at the screen on display.
 * - **A draft.** See `hasUnsavedText`.
 * - **Where the reader was.** `scroll: false`, and focus put back on the
 *   language that was chosen. Crossing the `[locale]` segment remounts the
 *   whole tree — watched in Chrome, where `document.activeElement` was `<body>`
 *   the instant the page returned in Spanish — so without both of these a
 *   keyboard user arrowing along the strip is thrown to the top of the document
 *   by the first key they press, and cannot press a second.
 */
export function LanguageCard({ hasUnsavedText = false }: LanguageCardProps) {
  const t = useTranslations("Language");
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const [pending, setPending] = useState<string | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  // Runs on every mount, and always consumes the marker — so an ordinary page
  // load takes no focus, and a switch that never landed cannot arm the next one.
  useEffect(() => {
    if (takeSwitch() !== locale) return;
    stripRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  }, [locale]);

  function switchTo(next: string) {
    setPending(null);
    // Remember first, navigate second — and `rememberLocale` swallows its own
    // failure, so a browser that refuses cookies cannot stop the switch.
    rememberLocale(next);
    switchedTo = next;
    router.replace(localeSwitchHref(pathname, window.location.search, next), { scroll: false });
  }

  function choose(next: string) {
    if (next === locale) return;
    if (hasUnsavedText) {
      setPending(next);
      return;
    }
    switchTo(next);
  }

  return (
    <Card>
      <h2 className="mb-3 text-base font-semibold text-fg">{t("title")}</h2>
      {/* The ref is on a wrapper rather than on `Segmented`: the strip is the
          shared control the theme preference uses, and it does not need a
          handle on its own DOM for anything else. */}
      <div ref={stripRef}>
        <Segmented options={localeOptions()} value={locale} onChange={choose} />
      </div>

      <Modal
        open={pending !== null}
        onClose={() => setPending(null)}
        title={t("confirmTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPending(null)}>
              {t("confirmCancel")}
            </Button>
            <Button onClick={() => pending && switchTo(pending)}>{t("confirmSwitch")}</Button>
          </>
        }
      >
        <p className="text-sm text-fg-secondary">{t("confirmBody")}</p>
      </Modal>
    </Card>
  );
}
