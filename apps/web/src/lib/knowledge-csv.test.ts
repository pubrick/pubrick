import { describe, expect, it } from "vitest";
import { KnowledgeCsvError, parseKnowledgeCsv, serializeKnowledgeCsv } from "./knowledge-csv";

describe("knowledge CSV import", () => {
  it("round-trips a custom category and rejects a malformed category atomically", () => {
    const entry = {
      title: "Partner",
      content: "Facts",
      category: "Retail Partners",
      tags: [],
      isActive: true,
    };
    expect(parseKnowledgeCsv(serializeKnowledgeCsv([entry])[0] ?? "")).toEqual([entry]);
    expect(() =>
      parseKnowledgeCsv(
        "title,content,category\nGood,Facts,product_info\nBad,Facts,bad\\u0000name\n".replace(
          "\\u0000",
          "\u0000",
        ),
      ),
    ).toThrowError(KnowledgeCsvError);
  });
  it("reads quoted commas, doubled quotes, CRLF and tags", () => {
    expect(
      parseKnowledgeCsv(
        'Title,Content,Category,Tags\r\n"A, B","Use ""care"".",case_study,"one|two"\r\n',
      ),
    ).toEqual([
      {
        title: "A, B",
        content: 'Use "care".',
        category: "case_study",
        tags: ["one", "two"],
        isActive: true,
      },
    ]);
  });

  it("preserves paused notes and delimiter-containing tags via the JSON column", () => {
    expect(
      parseKnowledgeCsv(
        'title,content,category,tags,tags_json,is_active\nVoice,Warm tone,brand_guidelines,ignored,"[""coffee, roasted"",""bulk|B2B""]",false\n',
      ),
    ).toEqual([
      {
        title: "Voice",
        content: "Warm tone",
        category: "brand_guidelines",
        tags: ["coffee, roasted", "bulk|B2B"],
        isActive: false,
      },
    ]);
  });

  it.each([
    "title,content,category,is_active\nVoice,Warm,brand_guidelines,\n",
    "title,content,category,is_active\nVoice,Warm,brand_guidelines,False\n",
    "title,content,category,tags_json\nVoice,Warm,brand_guidelines,\n",
    'title,content,category,tags_json\nVoice,Warm,brand_guidelines,"[1]"\n',
    'title,content,category,tags_json\nVoice,Warm,brand_guidelines,"[""bad\u0000tag""]"\n',
  ])("refuses a malformed optional value for the whole batch: %s", (csv) => {
    expect(() => parseKnowledgeCsv(csv)).toThrowError(KnowledgeCsvError);
  });

  it("refuses an invalid row instead of silently skipping it", () => {
    expect(() => parseKnowledgeCsv("title,content,category\nGood,,product_info\n")).toThrowError(
      KnowledgeCsvError,
    );
    try {
      parseKnowledgeCsv("title,content,category\nGood,,product_info\n");
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_row", row: 2 });
    }
  });
});

describe("knowledge CSV export", () => {
  it("round-trips literal tags, paused state, quotes and multiline UTF-8 content", () => {
    const entries = [
      {
        title: 'Crème, "special"',
        content: 'First line\nSecond "quoted" line',
        category: "brand_guidelines",
        tags: ["coffee, roasted", "bulk|B2B"],
        isActive: false,
      },
    ];
    const files = serializeKnowledgeCsv(entries);
    expect(files).toHaveLength(1);
    expect(parseKnowledgeCsv(files[0] ?? "")).toEqual(entries);
  });

  it("splits exports into files accepted by the CSV importer", () => {
    const entries = Array.from({ length: 501 }, (_, i) => ({
      title: `Note ${i}`,
      content: "é".repeat(4_000),
      category: "product_info",
      tags: [] as string[],
      isActive: true,
    }));
    const files = serializeKnowledgeCsv(entries);
    expect(files.length).toBeGreaterThan(1);
    expect(files.every((file) => new TextEncoder().encode(file).byteLength <= 1_000_000)).toBe(
      true,
    );
    expect(files.flatMap(parseKnowledgeCsv)).toEqual(entries);
  });
});
