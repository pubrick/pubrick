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
  ...rest
}: TextareaProps) {
  const generatedId = useId();
  const textareaId = id ?? generatedId;
  const showCounter = Boolean(showCount) && maxLength != null;
  const count = typeof value === "string" ? value.length : 0;

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
        className={[
          "min-h-24 rounded-control border border-border bg-panel px-3 py-2 text-sm text-fg",
          "placeholder:text-fg-tertiary",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
          "disabled:pointer-events-none disabled:opacity-50",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
        {...rest}
      />
      {showCounter && (
        <span data-testid="char-count" className="text-right text-xs text-fg-tertiary">
          {count} / {maxLength}
        </span>
      )}
    </div>
  );
}
