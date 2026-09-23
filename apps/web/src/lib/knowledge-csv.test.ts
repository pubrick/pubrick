import { describe, expect, it } from "vitest";
import { KnowledgeCsvError, parseKnowledgeCsv } from "./knowledge-csv";

describe("knowledge CSV import", () => {
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
