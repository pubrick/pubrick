# Public website

Pubrick has a public editorial website alongside its authenticated workspace.
English is the source copy, with complete Spanish, Russian and Portuguese
catalogues. Each page stays available without signing in:

| Page | Purpose |
| --- | --- |
| `/en` | Product introduction and source-to-review workflow |
| `/en/product` | Capabilities and the human approval boundary |
| `/en/use-cases` | Illustrative creator, brand and agency workflows |
| `/en/open-source` | License, architecture, self-hosting and contribution |
| `/en/hosting` | Available self-hosting and the hosted service's actual status |
| `/en/docs` | Maintained repository documentation index |

Replace `en` with `es`, `ru` or `pt` for the translated equivalent. Language
navigation retains the page. Product facts and launch limits are maintained in
`apps/web/messages/*.json`; do not add invented testimonials, user counts,
pricing or availability claims. Payments are deferred. The hosted page is not
a checkout or a promise of an operational public hosted service.

## Search indexing

The web container receives `PUBLIC_ORIGIN` at runtime. Server-rendered page
metadata, canonical URLs, locale alternatives and sitemap URLs use that origin;
the Docker image does not bake in a particular commercial domain.

For a public marketing deployment behind HTTPS, configure its `.env`:

```dotenv
PUBLIC_ORIGIN=https://your-public-domain.example
PUBLIC_SITE_INDEXING=true
```

Restart the web service after changing these values. Keep
`PUBLIC_SITE_INDEXING=false` for private installations; it is the default.
An absent or malformed origin disables indexing. An HTTP origin can be used for
a local trial, but cannot enable indexing. Only the six public pages enter the
sitemap. Authentication, workspace and review-token pages retain noindex
metadata or their existing privacy headers. Robots rules permit public pages
and the static assets needed to render them, while excluding other routes.
Robots instructions are crawler guidance, not an authorization boundary.

Each public page supplies its own title, description, canonical, locale
alternatives and Open Graph/Twitter metadata. The shared social card uses the
existing Pubrick artwork. The home page describes the software with factual
JSON-LD and omits fabricated ratings and commercial offers. Structured data
does not guarantee a search feature or ranking.

Before announcing a domain, check its rendered HTML, `/robots.txt`,
`/sitemap.xml`, social card, navigation and HTTPS redirects. Submit the actual
domain and sitemap to your search-console account; code alone cannot confirm
indexing or rankings. See the [Google SEO guide](https://developers.google.com/search/docs/fundamentals/seo-starter-guide)
and [Next.js metadata documentation](https://nextjs.org/docs/app/api-reference/functions/generate-metadata).

## Local acceptance

Build the web application, then run it on a separate local port with
`PUBLIC_ORIGIN=https://studio.example` and `PUBLIC_SITE_INDEXING=true`
set on the **running** server. The browser still connects to the local port;
the synthetic HTTPS origin is the expected SEO identity, not a live domain.

```sh
PUBRICK_SITE_ORIGIN=http://127.0.0.1:31550 pnpm exec playwright test --config=scripts/e2e/playwright-public.config.ts
```

This read-only browser scenario checks all 24 localized public routes, metadata,
sitemap, mobile overflow, same-page language switching and missing-page refusal.
It saves light/dark desktop and mobile screenshots under `.data/`. It does not
create an account, call an LLM, authorize publication or test payments.
