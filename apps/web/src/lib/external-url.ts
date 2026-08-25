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
