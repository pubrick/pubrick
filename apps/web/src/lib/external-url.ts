/**
 * Is a platform-supplied URL safe to hand to an `href`?
 *
 * `externalUrl` is whatever a platform adapter recorded on a publication — data
 * from outside this app, not a string the UI built. `href` accepts far more
 * than a web address, and a `javascript:` URL runs script in the page's own
 * origin the moment someone clicks the link, so the scheme is checked
 * explicitly rather than assumed.
 *
 * Only `https://` is rendered as a link. Anything else is still shown, as plain
 * text: whoever has to reconcile a publication can read the value, but it is
 * inert.
 */
export function isLinkableUrl(url: string | null | undefined): url is string {
  return typeof url === "string" && url.startsWith("https://");
}

/**
 * The same question for a person-supplied SOURCE address (`sourceUrl` on a
 * run's input), which the DTO admits over http as well as https. The DTO's
 * scheme check runs on the api; this app never parses the api's body, so a
 * row written by hand — `javascript://example.com/%0aalert(1)` parses to a
 * host of `example.com` and would reach an `href` — is stopped HERE, the
 * last place before the anchor. Anything else renders as plain text.
 */
export function isHttpUrl(url: string | null | undefined): url is string {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}
