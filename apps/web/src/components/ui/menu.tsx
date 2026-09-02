"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { TRANSITION_COLORS } from "./transition";

export type MenuItem = {
  label: string;
  onSelect: () => void;
  danger?: boolean;
};

export type MenuProps = {
  trigger: ReactNode;
  items: MenuItem[];
  className?: string;
};

/**
 * A menu button, with the keyboard model the role promises.
 *
 * `aria-haspopup="menu"` + `role="menu"` tell a screen-reader user that this
 * is a command menu — which carries a specific contract: opening moves focus
 * INTO the menu, arrows move between items, exactly one item is in the tab
 * order at a time, and Escape closes and puts focus back on the trigger. None
 * of that was implemented: Enter opened the panel and left focus on the
 * trigger, arrows did nothing, every item was its own Tab stop, and Escape
 * dropped focus on `document.body` — leaving a keyboard user with no visible
 * focus and no idea where they were.
 *
 * The roles are kept and the model implemented (rather than the reverse) for
 * one reason: this is the app's only action-list primitive, and a transient
 * list of commands summoned from a trigger IS what `role="menu"` describes.
 * Dropping to a plain disclosure of buttons would be honest about the
 * keyboard, but it would also stop announcing "menu, 3 items" — losing the one
 * thing that tells a non-sighted user something opened at all.
 */
export function Menu({ trigger, items, className }: MenuProps) {
  const [open, setOpen] = useState(false);
  // The roving tabindex: index of the single item that is tabbable/focused
  // while the menu is open.
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  /**
   * `returnFocus` is the whole point of the parameter: Escape and choosing an
   * item are keyboard journeys that must end back on the trigger, while an
   * outside click and Tab are the user deliberately going somewhere else —
   * yanking focus back there would fight them.
   */
  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        close(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") close(true);
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, close]);

  // Focus follows `activeIndex` for as long as the menu is open — on opening
  // (so Enter on the trigger lands somewhere) and on every arrow key.
  useEffect(() => {
    if (!open) return;
    itemRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);

  function openAt(index: number) {
    setActiveIndex(index);
    setOpen(true);
  }

  function handleTriggerKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      openAt(0);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      openAt(items.length - 1);
    }
    // Enter/Space fall through to the native click, which opens at index 0.
  }

  function handleMenuKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Tab") {
      // Tab leaves the menu entirely — that is the documented escape hatch,
      // and the panel must not stay open behind the moving focus.
      close(false);
      return;
    }
    const last = items.length - 1;
    let next: number | null = null;
    if (event.key === "ArrowDown") next = activeIndex >= last ? 0 : activeIndex + 1;
    else if (event.key === "ArrowUp") next = activeIndex <= 0 ? last : activeIndex - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    if (next === null) return;
    event.preventDefault();
    setActiveIndex(next);
  }

  return (
    <div
      ref={containerRef}
      className={["relative inline-block", className].filter(Boolean).join(" ")}
    >
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close(false) : openAt(0))}
        onKeyDown={handleTriggerKeyDown}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex"
      >
        {trigger}
      </button>
      {open && (
        <div
          role="menu"
          onKeyDown={handleMenuKeyDown}
          className="absolute right-0 z-40 mt-1 min-w-[160px] rounded-control border border-border bg-panel py-1 shadow-popover"
        >
          {items.map((item, index) => (
            <button
              key={item.label}
              ref={(node) => {
                itemRefs.current[index] = node;
              }}
              type="button"
              role="menuitem"
              // Exactly one tab stop for the whole menu, per the role's
              // contract: arrows move within, Tab moves out.
              tabIndex={index === activeIndex ? 0 : -1}
              onFocus={() => setActiveIndex(index)}
              onClick={() => {
                close(true);
                item.onSelect();
              }}
              className={[
                `block w-full px-3 py-2 text-left text-sm ${TRANSITION_COLORS} hover:bg-bg-sunken`,
                item.danger ? "text-danger" : "text-fg",
              ].join(" ")}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
