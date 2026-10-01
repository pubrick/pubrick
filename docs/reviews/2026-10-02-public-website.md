# Public website acceptance — 2026-10-02

## Scope

Six public server-rendered pages in English, Spanish, Russian and Portuguese;
shared navigation, locale switching, a local-only example using the real editor,
runtime canonical URLs, indexing opt-in, sitemap, robots and existing social artwork.
Payments remain deferred. Hosted public availability is explicitly not claimed.
The preceding feature package was pushed to main at
`ffd8af41573b562d2a3ac2b4f4cd9b0fdee0dd19` under the owner's authorization.

## Design decisions

The research and product-specific art direction are recorded in
[public-design.md](../public-design.md). Generic preview cards and a uniform
three-card feature row were replaced with a concrete studio-note example and
an editorial sequence. Existing product tokens and logo remain the identity.
The example is prewritten, clearly labeled, and sends no data to AI providers.

## Review findings addressed

- A navigation label collided with nested translation objects. Dedicated
  navigation keys now exist in all four catalogues.
- Indexable robots rules also need the locale-selecting root redirect.
  Exact root and public routes are allowed; private routes remain excluded.
- Full-page Chromium captures exposed the transform-hidden skip link.
  Use clipping when unfocused, retaining keyboard access and a visible focus state.

## Local evidence

- Initial focused checks: 139 tests passed, covering public SEO configuration,
  existing session actions, catalogue parity, authorship, contrast and environment guards.
- Release and Dockerfile script checks: 23 tests passed.
- Web TypeScript check and final production build passed.
- Final repository lint passed: 1,131 files checked; no fixes required.
- Final catalogue/metadata/session subset: 40 tests passed.
- Read-only browser acceptance passed across all 24 public routes, same-page
  language switching, metadata, sitemap, missing-page refusal and editor interactions.
  No mutating requests or browser page errors were observed.
- Mobile, desktop and dark screenshots were inspected. Keyboard skip-link
  acceptance and refreshed production screenshots passed after refinement.
- Full web suite: 1,596 tests passed and five failed across four unchanged files
  (brand settings, sources, calendar and new-content form). Timeouts and missing
  asynchronous options occurred under concurrent host load. A serial rerun of
  those four files passed 213 of 214 tests. The remaining calendar test
  `limits bulk selection to 20 approved topics` still exceeds 20 seconds.
  Its cause remains unresolved; the full run is not represented as green.
  No timeout was raised and no assertions were removed. This pre-existing
  calendar issue is tracked separately from the accepted public-site scenario.

## Limits

No public domain, search ranking, live hosted deployment or payment flow was tested.
The public-page browser fixture uses a deliberately unavailable API and therefore
exercises the anonymous public site, not a signed-in backend journey.
Release image validation is a separate task and has not finished; slow npm
registry transfers in Docker must not be described as a successful image build.
