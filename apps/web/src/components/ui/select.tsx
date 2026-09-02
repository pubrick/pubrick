"use client";

import type { ReactNode, SelectHTMLAttributes } from "react";
import { useId } from "react";

export type SelectProps = {
  label?: string;
  className?: string;
  children: ReactNode;
} & Omit<SelectHTMLAttributes<HTMLSelectElement>, "className" | "children">;

export function Select({ label, id, className, children, ...rest }: SelectProps) {
  const generatedId = useId();
  const selectId = id ?? generatedId;

  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={selectId} className="text-sm font-medium text-fg-secondary">
          {label}
        </label>
      )}
      <select
        id={selectId}
        className={[
          "h-9 rounded-control border border-border-strong bg-panel px-3 text-sm text-fg",
          "disabled:pointer-events-none disabled:opacity-50",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
        {...rest}
      >
        {children}
      </select>
    </div>
  );
}
