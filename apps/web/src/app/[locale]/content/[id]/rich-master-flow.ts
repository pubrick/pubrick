import { projectRichBody, type RichBody, richBodySchema } from "@pubrick/shared";

/** A plain draft can enter the rich editor only when its exact channel text survives. */
export function richDocumentFromPlainText(body: string): RichBody | null {
  const parsed = richBodySchema.safeParse({
    type: "doc",
    content: body.split("\n\n").map((text) => ({
      type: "paragraph",
      ...(text ? { content: [{ type: "text", text }] } : {}),
    })),
  });
  return parsed.success && projectRichBody(parsed.data) === body ? parsed.data : null;
}

export function hasRichApiSupport(item: {
  bodyRevision?: number;
  richBody?: RichBody | null;
}): boolean {
  return Number.isInteger(item.bodyRevision) && "richBody" in item;
}
