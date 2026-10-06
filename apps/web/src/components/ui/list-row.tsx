import Link from "next/link";
import type { ReactNode } from "react";
import { TRANSITION_COLORS } from "./transition";

export type ListRowProps = {
  id?: string;
  title: ReactNode;
  meta?: ReactNode;
  metaClassName?: string;
  trailing?: ReactNode;
  /** Multi-action records keep their title and metadata readable at narrow widths. */
  actionsBelow?: boolean;
  href?: string;
  className?: string;
};

/** The queue-row pattern from the canvas: title / meta stacked left, chips right. */
export function ListRow({
  id,
  title,
  meta,
  metaClassName,
  trailing,
  actionsBelow = false,
  href,
  className,
}: ListRowProps) {
  const classes = [
    "flex gap-4 border-b border-border-soft px-4 py-3 last:border-b-0",
    actionsBelow ? "flex-col items-stretch" : "items-center justify-between",
    href ? `${TRANSITION_COLORS} hover:bg-bg-sunken` : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const content = (
    <>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span
          className={`${actionsBelow ? "break-words whitespace-normal" : "truncate"} text-[15px] font-semibold text-fg`}
        >
          {title}
        </span>
        {meta && (
          <span className={`${metaClassName ?? "truncate"} text-[13px] text-fg-tertiary`}>
            {meta}
          </span>
        )}
      </span>
      {trailing && (
        <span
          className={
            actionsBelow
              ? "flex flex-wrap items-center gap-2 [&_button]:min-h-11"
              : "flex shrink-0 items-center gap-2"
          }
        >
          {trailing}
        </span>
      )}
    </>
  );

  if (href) {
    return (
      <Link id={id} href={href} className={classes}>
        {content}
      </Link>
    );
  }

  return (
    <div id={id} className={classes}>
      {content}
    </div>
  );
}
