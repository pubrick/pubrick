import { z } from "zod";
import { normalizeNewlines } from "./provenance.js";

function stripTrackingParameters(href: string): string {
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return href;
    let changed = false;
    for (const key of Array.from(url.searchParams.keys())) {
      if (/^utm_/i.test(key) || /^(fbclid|gclid|yclid|mc_cid|mc_eid)$/i.test(key)) {
        url.searchParams.delete(key);
        changed = true;
      }
    }
    return changed ? url.toString() : href;
  } catch {
    return href;
  }
}

const textMarkSchema = z.union([
  z.strictObject({ type: z.literal("bold") }),
  z.strictObject({ type: z.literal("italic") }),
  z.strictObject({
    type: z.literal("link"),
    attrs: z
      .strictObject({
        href: z.string().max(2048),
        // TipTap's default link mark serializes these display attributes. The
        // server discards them and owns the public target/rel policy.
        target: z.string().max(32).nullable().optional(),
        rel: z.string().max(128).nullable().optional(),
        class: z.string().max(128).nullable().optional(),
      })
      .transform(({ href }) => ({ href: stripTrackingParameters(href) })),
  }),
]);
const textNodeSchema = z.strictObject({
  type: z.literal("text"),
  text: z.string().max(4096),
  marks: z.array(textMarkSchema).max(3).optional(),
});
const paragraphSchema = z.strictObject({
  type: z.literal("paragraph"),
  content: z.array(textNodeSchema).max(256).optional(),
});
const headingSchema = z.strictObject({
  type: z.literal("heading"),
  attrs: z.strictObject({ level: z.union([z.literal(2), z.literal(3)]) }),
  content: z.array(textNodeSchema).max(256).optional(),
});
const listItemSchema = z.strictObject({
  type: z.literal("listItem"),
  content: z.array(paragraphSchema).min(1).max(8),
});
const bulletListSchema = z.strictObject({
  type: z.literal("bulletList"),
  content: z.array(listItemSchema).min(1).max(100),
});
const orderedListSchema = z.strictObject({
  type: z.literal("orderedList"),
  attrs: z.strictObject({ start: z.number().int().min(1).max(1000) }).optional(),
  content: z.array(listItemSchema).min(1).max(100),
});
export const richBodySchema = z
  .strictObject({
    type: z.literal("doc"),
    content: z
      .array(
        z.discriminatedUnion("type", [
          paragraphSchema,
          headingSchema,
          bulletListSchema,
          orderedListSchema,
        ]),
      )
      .min(1)
      .max(256),
  })
  .superRefine((document, context) => {
    if (new TextEncoder().encode(JSON.stringify(document)).length > 32_768) {
      context.addIssue({ code: "custom", message: "Rich body exceeds 32 KiB" });
    }
    let count = 1;
    for (const block of document.content) {
      count++;
      const lines =
        block.type === "bulletList" || block.type === "orderedList"
          ? block.content.flatMap((item) => {
              count += 1 + item.content.length;
              return item.content;
            })
          : [block];
      for (const line of lines) {
        count += line.content?.length ?? 0;
        for (const span of line.content ?? []) {
          if (span.text.includes("\0")) {
            context.addIssue({ code: "custom", message: "NUL bytes are not allowed" });
          }
          const seenMarks = new Set<string>();
          for (const mark of span.marks ?? []) {
            if (seenMarks.has(mark.type)) {
              context.addIssue({ code: "custom", message: "Duplicate rich text mark" });
            }
            seenMarks.add(mark.type);
            if (mark.type !== "link") continue;
            try {
              const url = new URL(mark.attrs.href);
              if (
                !["https:", "http:", "mailto:"].includes(url.protocol) ||
                (url.protocol !== "mailto:" && (!url.hostname || url.username || url.password))
              ) {
                throw new Error("Unsupported link");
              }
            } catch {
              context.addIssue({ code: "custom", message: "Link must use http, https or mailto" });
            }
          }
        }
      }
    }
    if (count > 1024) context.addIssue({ code: "custom", message: "Too many rich body nodes" });
  });
export type RichBody = z.infer<typeof richBodySchema>;

/** Channel text is deliberately complete: a labelled link includes its destination. */
export function projectRichBody(document: RichBody): string {
  const lineText = (line: {
    content?: { text: string; marks?: { type: string; attrs?: { href: string } }[] }[];
  }) => {
    let result = "";
    let linkedText = "";
    let linkedHref: string | undefined;
    const flush = () => {
      if (linkedHref)
        result += linkedText === linkedHref ? linkedText : `${linkedText} (${linkedHref})`;
      linkedText = "";
      linkedHref = undefined;
    };
    for (const span of line.content ?? []) {
      const href = span.marks?.find((mark) => mark.type === "link")?.attrs?.href;
      if (href !== linkedHref) flush();
      if (href) {
        linkedHref = href;
        linkedText += span.text;
      } else {
        result += span.text;
      }
    }
    flush();
    return result;
  };
  return normalizeNewlines(
    document.content
      .map((block) => {
        if (block.type === "bulletList" || block.type === "orderedList") {
          return block.content
            .map((item, index) =>
              item.content
                .map(
                  (line, paragraphIndex) =>
                    `${paragraphIndex === 0 ? (block.type === "bulletList" ? "- " : `${index + (block.attrs?.start ?? 1)}. `) : "  "}${lineText(line)}`,
                )
                .join("\n"),
            )
            .join("\n");
        }
        return lineText(block);
      })
      .join("\n\n"),
  );
}
