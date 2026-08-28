"use client";

export type SegmentedOption = { value: string; label: string };

export type SegmentedProps = {
  options: SegmentedOption[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
};

/**
 * Pill-switcher: role="tablist" of role="tab" buttons, active tab gets
 * aria-selected + a `--gray-100` background. That primitive has no `@theme`
 * utility of its own (primitives never appear in components per the token
 * contract) — `border-border-soft` is the semantic token defined as exactly
 * `var(--gray-100)` in light mode, and it adapts sanely in dark mode, so it
 * stands in for "gray-100 bg" here instead of a literal `bg-gray-100`
 * (which would resolve to Tailwind's own unrelated default gray).
 */
export function Segmented({ options, value, onChange, className }: SegmentedProps) {
  return (
    <div
      role="tablist"
      className={["inline-flex items-center gap-1", className].filter(Boolean).join(" ")}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(option.value)}
            className={[
              "rounded-control px-3.5 py-1.5 text-sm font-semibold transition-colors",
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
