import { knowledgeImportSchema } from "@pubrick/shared";
import { parse } from "csv-parse/browser/esm/sync";
import { stringify } from "csv-stringify/browser/esm/sync";

type PortableKnowledgeEntry = {
  title: string;
  content: string;
  category: string;
  tags: string[];
  isActive: boolean;
};

const EXPORT_HEADERS = ["title", "content", "category", "tags_json", "is_active"] as const;
const MAX_IMPORT_BYTES = 1_000_000;
const MAX_IMPORT_ROWS = 500;

/** Each file stays within the importer's row and UTF-8 byte limits. */
export function serializeKnowledgeCsv(entries: PortableKnowledgeEntry[]): string[] {
  if (entries.length === 0) return [];
  const header = stringify([EXPORT_HEADERS]);
  const encoder = new TextEncoder();
  const headerBytes = encoder.encode(header).byteLength;
  const files: string[] = [];
  let body = "";
  let bytes = headerBytes;
  let rows = 0;
  for (const entry of entries) {
    const record = stringify([
      [
        entry.title,
        entry.content,
        entry.category,
        JSON.stringify(entry.tags),
        String(entry.isActive),
      ],
    ]);
    const recordBytes = encoder.encode(record).byteLength;
    if (headerBytes + recordBytes > MAX_IMPORT_BYTES) {
      throw new KnowledgeCsvError("too_large");
    }
    if (rows === MAX_IMPORT_ROWS || bytes + recordBytes > MAX_IMPORT_BYTES) {
      files.push(header + body);
      body = "";
      bytes = headerBytes;
      rows = 0;
    }
    body += record;
    bytes += recordBytes;
    rows++;
  }
  if (rows > 0) files.push(header + body);
  return files;
}

export type KnowledgeCsvErrorCode = "invalid_header" | "invalid_row" | "too_many" | "too_large";

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
