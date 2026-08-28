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

/**
 * The button look, without the `<button>`.
 *
 * Exported for the one case that is genuinely a link and genuinely the screen's
 * primary action — the run receipt's "Draft ready", which navigates to the
 * finished draft and must stay a real anchor (middle-click, copy link) rather
 * than an onClick that fakes one. Sharing the class list keeps that link from
 * becoming a second, drifting definition of what a primary button looks like.
 */
export function buttonClasses(
  variant: ButtonVariant = "primary",
  size: ButtonSize = "md",
  className?: string,
): string {
  return [
    "inline-flex items-center justify-center gap-2 rounded-control font-semibold transition-colors",
    "disabled:pointer-events-none disabled:opacity-50",
    VARIANT_CLASSES[variant],
    SIZE_CLASSES[size],
    className,
  ]
    .filter(Boolean)
    .join(" ");
}

export function Button({
  variant = "primary",
  size = "md",
  type = "button",
  disabled,
  className,
  children,
  ...rest
}: ButtonProps) {
  const classes = buttonClasses(variant, size, className);

  return (
    <button type={type} className={classes} disabled={disabled} {...rest}>
      {children}
    </button>
  );
}
