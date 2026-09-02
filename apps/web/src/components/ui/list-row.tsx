import Link from "next/link";
import type { ReactNode } from "react";
import { TRANSITION_COLORS } from "./transition";

export type ListRowProps = {
  title: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  href?: string;
  className?: string;
};

/** The queue-row pattern from the canvas: title / meta stacked left, chips right. */
export function ListRow({ title, meta, trailing, href, className }: ListRowProps) {
  const classes = [
    "flex items-center justify-between gap-4 border-b border-border-soft px-4 py-3 last:border-b-0",
    href ? `${TRANSITION_COLORS} hover:bg-bg-sunken` : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const content = (
    <>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-[15px] font-semibold text-fg">{title}</span>
        {meta && <span className="truncate text-[13px] text-fg-tertiary">{meta}</span>}
      </span>
      {trailing && <span className="flex shrink-0 items-center gap-2">{trailing}</span>}
    </>
  );

  if (href) {
    return (
      <Link href={href} className={classes}>
        {content}
      </Link>
    );
  }

  return <div className={classes}>{content}</div>;
}
