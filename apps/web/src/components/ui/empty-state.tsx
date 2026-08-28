import type { ReactNode } from "react";

export type EmptyStateProps = {
  title: string;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
};

/** Constitution rule 5: a list with no data teaches the single next step. */
export function EmptyState({ title, action, icon, className }: EmptyStateProps) {
  return (
    <div
      className={["flex flex-col items-center gap-3 px-6 py-16 text-center", className]
        .filter(Boolean)
        .join(" ")}
    >
      {icon && (
        <span aria-hidden="true" className="text-fg-tertiary">
          {icon}
        </span>
      )}
      <p className="text-sm font-medium text-fg-secondary">{title}</p>
      {action}
    </div>
  );
}
