"use client";

import type { InputHTMLAttributes } from "react";
import { useId } from "react";

export type InputProps = {
  label?: string;
  className?: string;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "className">;

export function Input({ label, id, className, ...rest }: InputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;

  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={inputId} className="text-sm font-medium text-fg-secondary">
          {label}
        </label>
      )}
      <input
        id={inputId}
        className={[
          "h-9 rounded-control border border-border bg-panel px-3 text-sm text-fg",
          "placeholder:text-fg-tertiary",
          "disabled:pointer-events-none disabled:opacity-50",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
        {...rest}
      />
    </div>
  );
}
