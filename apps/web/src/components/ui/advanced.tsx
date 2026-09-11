"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { useId } from "react";
import { IconChevronRight } from "./icons";

export type AdvancedProps = {
  children: ReactNode;
  dirty?: boolean;
  label?: string;
  className?: string;
  /**
   * Open state, when the SCREEN needs a say in it — pass neither this nor
   * `onOpenChange` and the native `<details>` behaves exactly as it always
   * has, which is what every other caller relies on.
   *
   * It exists for one reason: a refusal may only name something the reader can
   * see (constitution), and the compose screen's primary action refuses over
   * what this section holds. Left shut, that sentence points at a box nobody
   * can see. A screen that opens it has to own the state, because a reader who
   * then closes it must be able to.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/**
 * THE progressive-disclosure component (constitution rule 2): every
 * screen's advanced options live inside this, identical everywhere — no
 * screen invents its own "show more". Native `<details>` gives collapse
 * behavior, keyboard support and `toBeVisible()`-testable hidden content
 * for free; the chevron and dot are decoration on top of it.
 *
 * When `dirty` is true — the section holds a value changed from its
 * default — a brick dot renders beside the label so collapsed non-default
 * state is never invisible (also constitution rule 2).
 */
export function Advanced({
  children,
  dirty = false,
  label,
  className,
  open,
  onOpenChange,
}: AdvancedProps) {
  const t = useTranslations("Ui");
  const resolvedLabel = label ?? t("advanced");
  const hintId = useId();

  return (
    <details
      open={open}
      onToggle={(event) => onOpenChange?.(event.currentTarget.open)}
      className={["group rounded-card border border-border bg-panel", className]
        .filter(Boolean)
        .join(" ")}
    >
      <summary
        aria-describedby={dirty ? hintId : undefined}
        className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-semibold text-fg [&::-webkit-details-marker]:hidden"
      >
        <span className="flex items-center gap-2">
          {resolvedLabel}
          {dirty && (
            <>
              <span
                aria-hidden="true"
                data-testid="advanced-dirty-dot"
                className="h-1.5 w-1.5 rounded-full bg-accent"
              />
              {/*
                The dot's meaning, for a reader who cannot see paint. The dot
                itself is `aria-hidden` and correctly so — it is decoration —
                which left a shut section holding 8 000 characters entirely
                absent from what a screen reader announces, on a screen whose
                primary action then refuses over that content. Described on the
                TRIGGER because the trigger is what a reader lands on while the
                section is shut, and it is the trigger that is being described.
              */}
              <span id={hintId} className="sr-only">
                {t("advancedDirtyHint")}
              </span>
            </>
          )}
        </span>
        <IconChevronRight
          size={16}
          className="shrink-0 text-fg-tertiary transition-transform group-open:rotate-90"
        />
      </summary>
      <div className="border-t border-border-soft px-4 py-3">{children}</div>
    </details>
  );
}
