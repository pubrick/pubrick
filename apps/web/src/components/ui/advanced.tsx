"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { IconChevronRight } from "./icons";

export type AdvancedProps = {
  children: ReactNode;
  dirty?: boolean;
  label?: string;
  className?: string;
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
export function Advanced({ children, dirty = false, label, className }: AdvancedProps) {
  const t = useTranslations("Ui");
  const resolvedLabel = label ?? t("advanced");

  return (
    <details
      className={["group rounded-card border border-border bg-panel", className]
        .filter(Boolean)
        .join(" ")}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-semibold text-fg [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-2">
          {resolvedLabel}
          {dirty && (
            <span
              aria-hidden="true"
              data-testid="advanced-dirty-dot"
              className="h-1.5 w-1.5 rounded-full bg-accent"
            />
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
