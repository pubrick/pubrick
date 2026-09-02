"use client";

import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useId, useRef } from "react";
import { IconClose } from "./icons";
import { TRANSITION_COLORS } from "./transition";

export type ModalProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
};

/**
 * Everything the browser will put in the tab order, expressed as a selector.
 *
 * Deliberately NOT filtered by visibility: `offsetParent`/`getClientRects` are
 * the only honest visibility tests, and jsdom has no layout, so a filter built
 * on them would drop every candidate in the test environment and make the trap
 * untestable exactly where it is cheapest to test. The dialog's own subtree is
 * the only thing queried, and nothing in it is hidden while it is open.
 */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "[contenteditable]",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.tabIndex >= 0 && element.getAttribute("aria-hidden") !== "true",
  );
}

/**
 * Desktop: centered card. <640px: bottom sheet — done with CSS breakpoints
 * only (no JS media query), per the brief. Escape closes; clicking the
 * backdrop closes; focus moves into the dialog on open and the keydown
 * listener is removed on close/unmount so it never leaks past this
 * component's lifetime.
 *
 * Focus is also TRAPPED, not merely moved. `aria-modal` hides the rest of the
 * page from assistive tech and from nothing else: the controls behind the
 * overlay stay in the browser's tab order, so a sighted keyboard user tabbing
 * out of the dialog lands on things they cannot see and cannot click (the
 * backdrop eats the pointer), with no visible focus anywhere on screen. Four
 * Tab presses out of "Discard your draft?" used to do exactly that. The
 * handler below wraps Tab and Shift+Tab at the ends of the dialog's own
 * focusable list, and pulls focus back if it is outside the dialog at all —
 * the case that matters when the modal is opened from a control that a click
 * left focused elsewhere.
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
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const dialog = dialogRef.current;
      if (!dialog) return;

      const focusable = focusableWithin(dialog);
      if (focusable.length === 0) {
        // Nothing to move to inside the dialog: keep focus on the dialog
        // itself rather than letting it escape to the page behind.
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      const active = document.activeElement as HTMLElement | null;

      if (!active || !dialog.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      // The dialog element itself is `tabIndex={-1}` and holds focus on open,
      // so Shift+Tab from it has no previous sibling inside and must wrap to
      // the last control; forward Tab from it reaches `first` on its own.
      if (event.shiftKey && (active === first || active === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
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
              className={`rounded-control p-1 text-fg-tertiary ${TRANSITION_COLORS} hover:bg-bg-sunken hover:text-fg`}
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
