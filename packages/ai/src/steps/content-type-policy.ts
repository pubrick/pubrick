import type { ContentType, PromptRole } from "@pubrick/shared";

/**
 * Trusted product instructions for the existing five roles. These formats do
 * not add a model call or a second generation engine. The selected value is a
 * closed enum parsed from the run receipt before it reaches this table.
 */
const POLICIES = {
  social_post: {
    researcher: ["Plan a social post for the brand's audience."],
    writer: ["Write a social post without a title."],
  },
  news_digest: {
    researcher: [
      "Plan a concise news digest from the supplied material. Separate what it actually says from context that is uncertain or missing; never imply you fetched or verified additional news.",
      "Prioritise what changed, why it matters to the brand's audience, and a practical takeaway.",
    ],
    writer: [
      "Write a news digest of roughly 800–1500 characters when the supplied facts support that length. Lead with the change, then its audience impact and a useful takeaway.",
      "Do not combine unrelated claims into a made-up story or present stale material as current news.",
    ],
    editor: [
      "Keep the digest concise and separate the reported facts from the brand's interpretation. Remove unsupported timeliness claims.",
    ],
    adapter: [
      "Preserve the news, its source context, and the practical takeaway within this channel's limit.",
    ],
  },
  expert_article: {
    researcher: [
      "Plan a substantive expert article: a specific thesis, three to five useful sections, and an actionable conclusion. Mark unsupported claims for omission rather than inventing sources.",
    ],
    writer: [
      "Write an expert article with a clear opening, three to five short sections with headings, and a practical conclusion. Aim for roughly 3000–4000 characters, within the master draft's hard limit.",
      "Use only facts supported by the supplied material. Do not invent citations, SEO data, quotations, or a link to a full article.",
    ],
    editor: [
      "Keep the article's argument and section structure while removing filler and unsupported authority claims.",
    ],
    adapter: [
      "Keep a structured article on channels with room for one; on shorter channels, write a self-contained summary of its thesis and main takeaway. Do not promise a full article at a link you were not given.",
    ],
  },
  educational: {
    researcher: [
      "Plan a practical how-to: name the learner's goal, the prerequisites stated in the material, ordered steps, and the expected result. Omit steps whose details are unsupported.",
    ],
    writer: [
      "Write a clear how-to with an explicit goal, ordered actionable steps, and a way for the reader to judge the result. Aim for roughly 1000–4000 characters within the master draft's hard limit.",
      "Do not invent product controls, commands, safety claims, or prerequisites absent from the supplied material.",
    ],
    editor: [
      "Check that the steps are ordered, usable, and supported by the material; remove vague encouragement and unsupported instructions.",
    ],
    adapter: [
      "Preserve the how-to's usable sequence within this channel's limit; if necessary, choose fewer supported steps rather than silently dropping a necessary prerequisite.",
    ],
  },
} as const satisfies Record<ContentType, Partial<Record<PromptRole, readonly string[]>>>;

export function contentTypePolicy(contentType: ContentType, role: PromptRole): readonly string[] {
  const policy: Partial<Record<PromptRole, readonly string[]>> = POLICIES[contentType];
  return policy[role] ?? [];
}
