/**
 * The colour transition every interactive surface uses — minus `outline-color`.
 *
 * Tailwind v4's own `transition-colors` expands to `color, background-color,
 * border-color, outline-color, text-decoration-color, fill, stroke, …`. The
 * app's single focus treatment (`globals.css`: `:focus-visible { outline: 2px
 * solid var(--color-accent) }`) is an OUTLINE, so `transition-colors` animates
 * the focus ring's colour: tab onto a button and the ring fades up from the
 * element's `currentColor` instead of appearing. A focus ring is a statement
 * about where you are right now, not a state change to narrate, and an
 * animated one is exactly the "motion as decoration" the design direction
 * rules out — it also lags a fast Tab-Tab-Tab, so the ring you see is the one
 * you already left.
 *
 * Listing the three properties that actually change on hover/active leaves the
 * outline alone. Kept as one exported constant rather than repeated literals so
 * the list cannot drift between components; `components/ui/transition.test.ts`
 * pins that no component reaches for the bare utility again.
 */
export const TRANSITION_COLORS = "transition-[color,background-color,border-color]";
