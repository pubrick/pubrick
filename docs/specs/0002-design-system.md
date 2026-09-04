# Pubrick Design System & UX Constitution (Design)

**Date:** 2026-08-25
**Status:** Historical record of a decision the codebase still lives with —
not living documentation. The design shipped; where this document and the
code disagree, the code is right. For the living pattern reference, see
`docs/ux-patterns.md`; for the current component set, see
`apps/web/src/components/ui/`.
**Provenance:** Copied (front matter adapted; body otherwise verbatim) from
the project's private planning repository on 2026-09-04. That repository
also held an interactive design canvas showing the approved shell direction
and two rejected alternatives — a private working file, not archived here
and not part of this repository's history.
**Owner decisions (2026-08-25):** restrained-tool aesthetic (Things 3 /
macOS Settings lineage, not Linear-dense, not consumer-playful); light and
dark themes from day one (light default); shell direction A "Library"
(sidebar) with the mobile answer being a bottom tab bar; responsive web +
PWA manifest (no offline, no push); Tailwind 4 over our own CSS-variable
tokens, custom components, no UI kit.

---

## 1. Why this exists

The product's stated differentiators — "doesn't scare beginners, advanced
users always find their options" — are UX claims, not visual ones. This
spec therefore has two layers: a small **UX constitution** (rules every
future screen must obey, reviewable in PRs) and a **design system** (tokens,
components, shell) that implements it. The constitution outranks the
pixels: a beautiful screen that moves Settings is a spec violation.

## 2. UX constitution

Five rules. Every new screen is checked against them in review; the repo's
CLAUDE.md gets a condensed copy so agents enforce them too.

1. **One-place rule.** Fixed, never-moving locations:
   - Settings: desktop — bottom of the sidebar; mobile — rightmost tab.
   - The screen's primary action: ONE brick-colored button, top-right of
     the content area (mobile: a round brick button beside the large
     title). On form screens (compose, settings) the same rule applies:
     the submit/save button sits top-right in the toolbar, not at the
     bottom of the form. Never two primary buttons on one screen.
   - Search: immediately left of the primary action.
   - The current user/workspace: bottom of the sidebar, under Settings
     (mobile: inside Settings).
2. **Progressive disclosure.** Forms show only what is required. Every
   advanced option lives inside the uniform `Advanced` component — a
   collapsed "Advanced" section at the END of a form, identical on every
   screen. When a collapsed section contains values changed from their
   defaults, its header shows a dot indicator, so hidden non-default
   state is never invisible. No screen invents its own "show more"
   pattern.
3. **One verb, one word.** Approve / Reject / Publish / Schedule / Test
   connection are called the same thing on every screen, in every toast
   and empty state. The vocabulary lives in `messages/en.json` and is
   guarded by the existing test policy (assertions read the real
   messages file).
4. **One status scale.** Exactly five status colors with fixed
   background/text pairs (tokens in §5): draft (gray), needs review
   (brick-tinted orange), scheduled (blue), published (green), failed
   (red). New status colors require changing this spec.
5. **Empty states teach.** A list with no data shows the single next step
   and its button ("Connect your first channel"), never a bare "nothing
   here".

## 3. Shell

Approved direction A "Library" (see canvas):

- **≥1024px:** left sidebar 232px on `paper`, content area on white.
  Sidebar: logo top; nav sections — ONLY screens that exist today (Queue,
  Brands; Calendar joins the moment that feature ships, and Compose is
  the primary ACTION, not a nav destination); spacer; Settings + user
  pinned bottom. Content: 26px semibold title, toolbar row (segmented
  filter left, search + primary button right). Dead menu items are a
  constitution violation — nav never advertises screens that do not
  exist.
- **640–1024px:** the sidebar collapses to a 60px icon rail (same order,
  same pinned bottom; labels become tooltips). This reuses the rail from
  archived direction C.
- **<640px:** bottom tab bar — Queue, Brands, Settings today (a fourth
  Calendar tab is reserved for when that feature ships); iOS-style large
  title; the primary action is a round
  44px brick button beside the title. Compose and the post detail open as
  full-screen steps (no side panels). Touch targets ≥44px.
- **Settings screen (new, first wave):** the one-place rule needs a real
  destination, so this phase ships a minimal Settings screen: Appearance
  (theme: system / light / dark), Account (email, sign out), Workspace
  (organization name, read-only for now). The theme toggle lives here and
  nowhere else.
- **PWA:** web app manifest (name, icons derived from the brick mark,
  `display: standalone`, theme colors per scheme). No service worker, no
  offline, no push in this phase.

## 4. Visual language

- **Type:** system stack (`-apple-system, system-ui, "Segoe UI",
  sans-serif`) — the honest Apple feel at zero font-loading cost. Scale:
  12 / 13 / 14 / 15 / 17 / 21 / 26 / 32, semibold-to-bold headings with
  tightened tracking (−0.02em at 26+). Body line-height 1.5–1.6.
- **Color:** two-layer tokens. Primitives (`--brick-500: #e67131`, ink,
  paper, gray ramp, status hues) feed semantic tokens (`--color-accent`,
  `--color-bg`, `--color-panel`, `--color-border`, `--color-text-secondary`,
  `--status-published-bg/-fg`, …). Dark theme redefines ONLY the semantic
  layer (the pattern already started in `globals.css`). All grays are
  slightly cool neutrals derived from paper/ink; whites keep saturation
  ≤0.02.
- **Depth:** radii 6 (chips) / 8 (controls) / 10 (cards) / 12 (large
  cards); two shadows only — `--shadow-card` (subtle) and
  `--shadow-popover` (pronounced); 1px borders from the gray ramp do most
  of the separation work.
- **Motion:** 150ms ease-out for hovers/reveals, 220ms for
  sheets/modals; `prefers-reduced-motion` disables non-essential
  transitions. One rule: motion communicates state change, never
  decoration.
- **Iconography:** in-house inline-SVG set, stroke 1.6, 20px grid (16/22
  variants), started in the canvas mockups. No emoji, no icon fonts, no
  external icon package.

## 5. Implementation approach

- **Tailwind 4, CSS-first.** Tokens are CSS custom properties in
  `globals.css`; Tailwind 4's `@theme` consumes them directly (no JS
  config). Components use Tailwind utilities; anything token-like never
  appears as a literal in a component — it goes through the token.
- **Components in `apps/web/src/components/ui/`** (no `packages/ui` —
  single consumer, YAGNI). First wave: Button (primary/secondary/ghost ×
  md/sm), Input + Textarea (with the character counter), Select,
  SegmentedControl, StatusBadge, Card, ListRow, Sheet/Modal, Menu,
  Advanced (the disclosure), Toast, EmptyState, Skeleton, Sidebar,
  Tabbar. Accessibility baseline: real buttons/links, focus-visible
  rings (brick), labels tied to inputs, Escape closes overlays.
- **`/design` gallery instead of Storybook:** one dev-only route
  rendering every component in every state, both themes side by side.
  It is the review surface for visual PRs and costs no infrastructure.
- **Dark theme** ships with the tokens (semantic-layer overrides +
  a manual toggle stored per user; default follows the OS).

## 6. Compatibility constraints

- The 91 web tests pin translation strings, roles, disabled states and
  link semantics. The restyle must not rename any `messages/*.json` key,
  change element roles, or alter the disabled/link behaviors — a plan
  task that needs to change a string does it as an explicit, named step.
- The existing `renderAsync`/`render` test harness continues to work:
  components stay client components; no CSS-in-JS runtime is introduced.
- Biome formats Tailwind class strings as plain strings (no plugin
  needed); no new lint machinery.

## 7. Out of scope

Marketing/landing pages; offline and push; native apps; animation beyond
transitions; Storybook or visual-regression infrastructure; redesigning
the email templates. The archived shell directions B/C stay on the canvas
as reference only.
