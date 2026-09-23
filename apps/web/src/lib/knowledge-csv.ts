import { knowledgeImportSchema } from "@pubrick/shared";
import { parse } from "csv-parse/browser/esm/sync";

export type KnowledgeCsvErrorCode = "invalid_header" | "invalid_row" | "too_many";

export class KnowledgeCsvError extends Error {
  constructor(
    public readonly code: KnowledgeCsvErrorCode,
    public readonly row?: number,
  ) {
    super(code);
  }
}

/** Parse quoted CSV through a maintained library; validate each row at the API boundary's schema. */
export function parseKnowledgeCsv(text: string) {
  let headersSeen = false;
  let records: Record<string, string>[];
  try {
    records = parse(text, {
      bom: true,
      skip_empty_lines: true,
      trim: true,
      columns: (headers: string[]) => {
        const normalized = headers.map((header) => header.trim().toLowerCase());
        if (
          ["title", "content", "category"].some((required) => !normalized.includes(required)) ||
          new Set(normalized).size !== normalized.length
        ) {
          throw new KnowledgeCsvError("invalid_header");
        }
        headersSeen = true;
        return normalized;
      },
    }) as Record<string, string>[];
  } catch (error) {
    if (error instanceof KnowledgeCsvError) throw error;
    throw new KnowledgeCsvError(headersSeen ? "invalid_row" : "invalid_header");
  }
  if (records.length === 0) throw new KnowledgeCsvError("invalid_row");
  if (records.length > 500) throw new KnowledgeCsvError("too_many");
  const entrySchema = knowledgeImportSchema.shape.entries.element;
  return records.map((record, index) => {
    let tags: unknown;
    try {
      // An explicit JSON column is authoritative, including []. A blank or malformed
      // cell is refused so a lossy fallback cannot silently change imported tags.
      tags = Object.hasOwn(record, "tags_json")
        ? JSON.parse(record.tags_json ?? "")
        : (record.tags ?? "")
            .split(/[|,]/)
            .map((tag) => tag.trim())
            .filter(Boolean);
    } catch {
      throw new KnowledgeCsvError("invalid_row", index + 2);
    }
    const parsed = entrySchema.safeParse({
      title: record.title,
      content: record.content,
      category: record.category,
      tags,
      isActive: Object.hasOwn(record, "is_active")
        ? record.is_active === "true"
          ? true
          : record.is_active === "false"
            ? false
            : "invalid"
        : undefined,
    });
    if (!parsed.success) throw new KnowledgeCsvError("invalid_row", index + 2);
    return parsed.data;
  });
}
