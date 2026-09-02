"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { TRANSITION_COLORS } from "./transition";

export type SegmentedOption = { value: string; label: string };

export type SegmentedProps = {
  options: SegmentedOption[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
};

/** How much of the strip the edge fade covers when there is more to scroll to. */
const FADE = "24px";

/**
 * Pill-switcher: role="tablist" of role="tab" buttons, active tab gets
 * aria-selected + a `--gray-100` background. That primitive has no `@theme`
 * utility of its own (primitives never appear in components per the token
 * contract) — `border-border-soft` is the semantic token defined as exactly
 * `var(--gray-100)` in light mode, and it adapts sanely in dark mode, so it
 * stands in for "gray-100 bg" here instead of a literal `bg-gray-100`
 * (which would resolve to Tailwind's own unrelated default gray).
 *
 * The roles are kept and the keyboard model implemented, rather than the
 * reverse. A tablist is a COMPOSITE widget: one tab stop for the whole strip,
 * arrows to move between options, and "selected, 2 of 3" announced on arrival.
 * That is what this control is — exactly one of N is chosen and the choice
 * decides what the region below shows. The alternative on offer, a group of
 * `aria-pressed` toggle buttons, would trade one untruth for another: it
 * describes N independent switches that happen to be off, says nothing about
 * how many options exist, and puts every one of them in the Tab order. What
 * was missing here was never the role — it was the arrow keys and the roving
 * tabindex, and those are twenty lines.
 *
 * Below ~375px a six-option strip overflows. It always scrolled; nothing said
 * so, so the options past the edge simply did not exist for the reader. The
 * edge fade is painted with `mask-image` rather than a gradient overlay
 * precisely because this control sits on two different grounds (a Card in
 * Settings, the page in the queue) — a mask fades to whatever is actually
 * behind it, a gradient would have to guess.
 */
export function Segmented({ options, value, onChange, className }: SegmentedProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [edges, setEdges] = useState({ start: false, end: false });

  // The single tab stop. `findIndex` returns -1 for a value that is not in
  // `options` (a filter restored from a URL that no longer exists, say) —
  // falling back to 0 keeps the strip reachable by Tab instead of leaving
  // every button at tabIndex -1 and the control unreachable.
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  const measure = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    // 1px of slack: fractional layout widths otherwise report a permanent
    // 0.5px overflow and paint a fade over a strip that fits.
    setEdges({ start: el.scrollLeft > 1, end: el.scrollLeft < max - 1 });
  }, []);

  useEffect(() => {
    measure();
    const el = scrollerRef.current;
    if (!el) return;
    el.addEventListener("scroll", measure, { passive: true });
    // jsdom has neither layout nor ResizeObserver; the fade is a browser-only
    // affordance and simply stays off there.
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => measure());
    observer?.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [measure]);

  // Re-measure when the option set changes: a strip that fits three labels may
  // not fit six.
  // biome-ignore lint/correctness/useExhaustiveDependencies: measure() reads the DOM, so the option list is the trigger, not a value it closes over.
  useEffect(measure, [options, measure]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const last = options.length - 1;
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown")
      next = selectedIndex >= last ? 0 : selectedIndex + 1;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp")
      next = selectedIndex <= 0 ? last : selectedIndex - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    if (next === null) return;
    const target = options[next];
    if (!target) return;
    event.preventDefault();
    // Automatic activation: for a tablist whose panel is already rendered,
    // arrowing to a tab selects it. `focus()` also scrolls it into view, which
    // is why nothing here calls scrollIntoView by hand.
    onChange(target.value);
    buttonRefs.current[next]?.focus();
  }

  const maskImage =
    edges.start || edges.end
      ? `linear-gradient(to right, ${edges.start ? `transparent 0, #000 ${FADE}` : "#000 0"}, ${
          edges.end ? `#000 calc(100% - ${FADE}), transparent 100%` : "#000 100%"
        })`
      : undefined;

  return (
    <div
      ref={scrollerRef}
      role="tablist"
      onKeyDown={handleKeyDown}
      style={maskImage ? { maskImage, WebkitMaskImage: maskImage } : undefined}
      className={["flex max-w-full items-center gap-1 overflow-x-auto", className]
        .filter(Boolean)
        .join(" ")}
    >
      {options.map((option, index) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            ref={(node) => {
              buttonRefs.current[index] = node;
            }}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={index === selectedIndex ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={[
              `shrink-0 whitespace-nowrap rounded-control px-3.5 py-1.5 text-sm font-semibold ${TRANSITION_COLORS}`,
              active ? "bg-border-soft text-fg" : "text-fg-secondary hover:text-fg",
            ].join(" ")}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
