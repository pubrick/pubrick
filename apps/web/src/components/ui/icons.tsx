import type { ReactNode } from "react";

/**
 * Pubrick icon set — 20x20 grid, stroke 1.6, round caps/joins, `currentColor`.
 * Queue / brands / settings / compose / search / plus / chevron-down paths
 * are ported verbatim from the design canvas artboards
 * (.superpowers/sdd design assets); the rest (chevron-right, close, check,
 * warning, external, user, moon, sun, monitor) are drawn to match.
 */
export type IconProps = {
  size?: 16 | 20 | 22;
  className?: string;
};

function IconBase({ size = 20, className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {children}
    </svg>
  );
}

export function IconQueue(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M2.5 11.5h4l1.5 2.5h4l1.5-2.5h4" />
      <path d="M4.5 4h11l2 7.5v4a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5v-4z" />
    </IconBase>
  );
}

export function IconBrands(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3" y="3" width="6.5" height="6.5" rx="1.5" />
      <rect x="10.5" y="3" width="6.5" height="6.5" rx="1.5" />
      <rect x="3" y="10.5" width="6.5" height="6.5" rx="1.5" />
      <rect x="10.5" y="10.5" width="6.5" height="6.5" rx="1.5" />
    </IconBase>
  );
}

export function IconSettings(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="10" cy="10" r="2.6" />
      <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4" />
    </IconBase>
  );
}

export function IconCompose(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M13.5 3.5l3 3L7 16H4v-3z" />
    </IconBase>
  );
}

export function IconSearch(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="9" cy="9" r="5.5" />
      <path d="M13.5 13.5L17 17" />
    </IconBase>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M10 4v12M4 10h12" />
    </IconBase>
  );
}

export function IconChevronDown(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M6 8l4 4 4-4" />
    </IconBase>
  );
}

export function IconChevronRight(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M8 6l4 4-4 4" />
    </IconBase>
  );
}

export function IconClose(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />
    </IconBase>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4.5 10.5l3.5 3.5 7.5-8" />
    </IconBase>
  );
}

export function IconWarning(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M10 3L18 17H2z" />
      <path d="M10 8v3.5" />
      <line x1="10" y1="14.5" x2="10.01" y2="14.5" />
    </IconBase>
  );
}

export function IconExternal(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M8.5 4.5H5A1.5 1.5 0 0 0 3.5 6v9A1.5 1.5 0 0 0 5 16.5h9a1.5 1.5 0 0 0 1.5-1.5v-3.5" />
      <path d="M11.5 3.5H16.5V8.5" />
      <path d="M9 11L16.5 3.5" />
    </IconBase>
  );
}

export function IconUser(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="10" cy="7" r="3.2" />
      <path d="M3.5 17c0-3.6 2.9-6.5 6.5-6.5s6.5 2.9 6.5 6.5" />
    </IconBase>
  );
}

export function IconMoon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M17 11.2A7.5 7.5 0 1 1 9.3 3a6 6 0 0 0 7.7 8.2z" />
    </IconBase>
  );
}

export function IconSun(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="10" cy="10" r="3.2" />
      <path d="M10 3v1.6M10 15.4V17M3 10h1.6M15.4 10H17M5.3 5.3l1.1 1.1M13.6 13.6l1.1 1.1M14.7 5.3l-1.1 1.1M6.4 13.6l-1.1 1.1" />
    </IconBase>
  );
}

export function IconMonitor(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3" y="4" width="14" height="9.5" rx="1.5" />
      <path d="M7 17h6M10 13.5V17" />
    </IconBase>
  );
}
