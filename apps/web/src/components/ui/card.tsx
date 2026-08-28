import type { HTMLAttributes, ReactNode } from "react";

export type CardProps = {
  padded?: boolean;
  children: ReactNode;
  className?: string;
} & Omit<HTMLAttributes<HTMLDivElement>, "className" | "children">;

export function Card({ padded = true, children, className, ...rest }: CardProps) {
  return (
    <div
      className={[
        "rounded-card border border-border bg-panel shadow-card",
        padded ? "p-4" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {children}
    </div>
  );
}
