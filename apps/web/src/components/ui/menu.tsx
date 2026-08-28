"use client";

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";

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

/** Popover panel; closes on Escape and on an outside click. */
export function Menu({ trigger, items, className }: MenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div
      ref={containerRef}
      className={["relative inline-block", className].filter(Boolean).join(" ")}
    >
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex"
      >
        {trigger}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-40 mt-1 min-w-[160px] rounded-control border border-border bg-panel py-1 shadow-popover"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className={[
                "block w-full px-3 py-2 text-left text-sm transition-colors hover:bg-bg-sunken",
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
