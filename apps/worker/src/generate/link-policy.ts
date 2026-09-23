import {
  type BrandLinkPolicy,
  type ContentType,
  DEFAULT_UTM,
  type PlatformId,
} from "@pubrick/shared";
import { linkifyit } from "linkify-it";

const linkify = linkifyit({ fuzzyLink: false, fuzzyEmail: false });

/**
 * Generation-time policy. Only the brand's bare homepage is tagged. Source
 * citations and all other external links survive unchanged; a specific brand
 * page is never collapsed to the homepage. The resulting
 * text is the draft an editor sees and may change before approval.
 */
export function applyLinkPolicy(
  text: string,
  policy: BrandLinkPolicy | null,
  platform: PlatformId | null,
  runCreatedAt: Date,
  contentType: ContentType = "social_post",
  maxLength = Number.POSITIVE_INFINITY,
): string {
  if (!policy || !platform) return text;
  let homepage: URL;
  try {
    homepage = new URL(policy.website);
  } catch {
    // The DB JSON column can contain historical or operator-written values.
    // Bad configuration must not discard a draft after its AI calls were paid.
    return text;
  }
  const mapping = policy.platforms[platform] ?? DEFAULT_UTM[platform];
  if (!mapping) return text;
  const campaign = policy.campaignTemplate
    .replaceAll(
      "{YYYY_MM}",
      `${runCreatedAt.getUTCFullYear()}_${String(runCreatedAt.getUTCMonth() + 1).padStart(2, "0")}`,
    )
    .replaceAll("{content_type}", contentType);
  const destination = new URL(homepage);
  destination.searchParams.set("utm_source", mapping.source);
  destination.searchParams.set("utm_medium", mapping.medium);
  destination.searchParams.set("utm_campaign", campaign);

  const matches = linkify.match(text);
  if (!matches) return text;
  let output = text;
  for (const match of [...matches].reverse()) {
    // With URL authentication disabled, linkify-it deliberately stops before
    // `@` (or `:password@`). That prefix is not a standalone homepage link.
    const tail = text.slice(match.lastIndex).split(/[\s)\]>]/, 1)[0] ?? "";
    if (/^(@|:[^/]*@)/.test(tail)) continue;
    let url: URL;
    try {
      url = new URL(match.url);
    } catch {
      continue;
    }
    if (!["http:", "https:"].includes(url.protocol)) continue;
    if (url.host !== homepage.host || url.pathname !== "/" || url.search || url.hash) continue;
    output = `${output.slice(0, match.index)}${destination.toString()}${output.slice(match.lastIndex)}`;
  }
  // The model output already passed the platform's length schema. UTM tags
  // must not turn that valid draft into one the editor cannot approve.
  return output.length <= maxLength ? output : text;
}
