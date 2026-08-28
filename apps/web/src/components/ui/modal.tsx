"use client";

import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useId, useRef } from "react";
import { IconClose } from "./icons";

export type ModalProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
};

/**
 * Desktop: centered card. <640px: bottom sheet — done with CSS breakpoints
 * only (no JS media query), per the brief. Escape closes; clicking the
 * backdrop closes; focus moves into the dialog on open and the keydown
 * listener is removed on close/unmount so it never leaks past this
 * component's lifetime.
 */
export function Modal({ open, onClose, title, children, footer }: ModalProps) {
  const t = useTranslations("Ui");
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50">
      {/* A real <button> rather than a click handler on a bare <div>, so the
          backdrop stays keyboard/a11y-clean (no synthetic role + keydown
          duplicate of the Escape handler above is needed for this part).
          It is deliberately unnamed, aria-hidden and pulled out of the tab
          order: the header's Close button and Escape are the accessible
          affordances, so this click target doesn't get exposed to assistive
          tech as a second, redundant "Close" control ahead of the dialog. */}
      <button
        type="button"
        onClick={onClose}
        tabIndex={-1}
        aria-hidden="true"
        className="absolute inset-0 cursor-default bg-overlay"
      />
      <div className="pointer-events-none absolute inset-0 flex items-end justify-center sm:items-center">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          className="pointer-events-auto max-h-[90vh] w-full overflow-y-auto rounded-t-card-lg border-t border-border bg-panel shadow-popover focus:outline-none sm:max-w-[480px] sm:rounded-card-lg sm:border"
        >
          <div className="flex items-center justify-between gap-4 border-b border-border-soft px-5 py-4">
            <h2 id={titleId} className="text-[17px] font-semibold text-fg">
              {title}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label={t("close")}
              className="rounded-control p-1 text-fg-tertiary transition-colors hover:bg-bg-sunken hover:text-fg"
            >
              <IconClose size={16} />
            </button>
          </div>
          <div className="px-5 py-4">{children}</div>
          {footer && (
            <div className="flex items-center justify-end gap-2 border-t border-border-soft px-5 py-4">
              {footer}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
