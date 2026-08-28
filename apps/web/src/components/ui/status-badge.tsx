import type { ReactNode } from "react";

export type StatusBadgeStatus = "draft" | "review" | "scheduled" | "published" | "failed";

export type StatusBadgeProps = {
  status: StatusBadgeStatus;
  children: ReactNode;
  className?: string;
};

// The only five status colors that exist (spec §2.4). These `--status-*`
// variables are deliberately not registered in the `@theme` block (they are
// not general-purpose theme colors), so they are referenced via Tailwind's
// arbitrary-value syntax rather than a generated `bg-status-*` utility —
// still 100% token-backed, just not through a named utility class.
const STATUS_CLASSES: Record<StatusBadgeStatus, string> = {
  draft: "bg-[var(--status-draft-bg)] text-[var(--status-draft-fg)]",
  review: "bg-[var(--status-review-bg)] text-[var(--status-review-fg)]",
  scheduled: "bg-[var(--status-scheduled-bg)] text-[var(--status-scheduled-fg)]",
  published: "bg-[var(--status-published-bg)] text-[var(--status-published-fg)]",
  failed: "bg-[var(--status-failed-bg)] text-[var(--status-failed-fg)]",
};

export function StatusBadge({ status, children, className }: StatusBadgeProps) {
  return (
    <span
      className={[
        "inline-flex items-center rounded-chip px-2.5 py-1 text-xs font-semibold",
        STATUS_CLASSES[status],
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </span>
  );
}
