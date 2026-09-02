"use client";

import type { TextareaHTMLAttributes } from "react";
import { useId } from "react";

export type TextareaProps = {
  label?: string;
  className?: string;
  showCount?: boolean;
} & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className">;

export function Textarea({
  label,
  id,
  className,
  showCount,
  maxLength,
  value,
  "aria-describedby": ariaDescribedBy,
  ...rest
}: TextareaProps) {
  const generatedId = useId();
  const textareaId = id ?? generatedId;
  const showCounter = Boolean(showCount) && maxLength != null;
  const count = typeof value === "string" ? value.length : 0;
  const counterId = `${textareaId}-count`;
  // Merge with a caller-supplied aria-describedby rather than overwrite it —
  // the counter is one of possibly several descriptions (e.g. a hint too).
  const describedBy =
    [ariaDescribedBy, showCounter ? counterId : null].filter(Boolean).join(" ") || undefined;

  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={textareaId} className="text-sm font-medium text-fg-secondary">
          {label}
        </label>
      )}
      <textarea
        id={textareaId}
        value={value}
        maxLength={maxLength}
        aria-describedby={describedBy}
        className={[
          "min-h-24 rounded-control border border-border-strong bg-panel px-3 py-2 text-sm text-fg",
          "placeholder:text-fg-tertiary",
          "disabled:pointer-events-none disabled:opacity-50",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
        {...rest}
      />
      {showCounter && (
        <span
          id={counterId}
          data-testid="char-count"
          className="text-right text-xs text-fg-tertiary"
        >
          {count} / {maxLength}
        </span>
      )}
    </div>
  );
}
