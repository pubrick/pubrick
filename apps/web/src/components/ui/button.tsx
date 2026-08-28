import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "md" | "sm";

export type ButtonProps = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: ReactNode;
  className?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children">;

// primary = accent bg / white text; secondary = panel bg + border;
// ghost = no border; danger = ghost shape with danger-colored text.
const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "border border-transparent bg-accent text-white hover:bg-accent-hover",
  secondary: "border border-border bg-panel text-fg hover:bg-bg-sunken",
  ghost: "border border-transparent bg-transparent text-fg hover:bg-bg-sunken",
  danger: "border border-transparent bg-transparent text-danger hover:bg-bg-sunken",
};

// 36px / 30px control heights.
const SIZE_CLASSES: Record<ButtonSize, string> = {
  md: "h-9 px-4 text-sm",
  sm: "h-[30px] px-3 text-sm",
};

export function Button({
  variant = "primary",
  size = "md",
  type = "button",
  disabled,
  className,
  children,
  ...rest
}: ButtonProps) {
  const classes = [
    "inline-flex items-center justify-center gap-2 rounded-control font-semibold transition-colors",
    "disabled:pointer-events-none disabled:opacity-50",
    VARIANT_CLASSES[variant],
    SIZE_CLASSES[size],
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button type={type} className={classes} disabled={disabled} {...rest}>
      {children}
    </button>
  );
}
