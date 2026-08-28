export type SkeletonProps = {
  lines?: number;
  className?: string;
};

/**
 * Shimmer-free per the motion rule (motion communicates state change, never
 * decoration) — flat `gray-100`-token bars, no animation. Purely decorative,
 * so it is hidden from assistive tech; the surrounding screen is responsible
 * for announcing its own loading state.
 */
export function Skeleton({ lines = 3, className }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={["flex flex-col gap-2", className].filter(Boolean).join(" ")}
    >
      {Array.from({ length: lines }).map((_, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length decorative placeholder list, never reordered
          key={index}
          className="h-3 rounded-chip bg-border-soft"
          style={index === lines - 1 ? { width: "60%" } : undefined}
        />
      ))}
    </div>
  );
}
