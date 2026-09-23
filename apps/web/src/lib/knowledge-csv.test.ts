import { describe, expect, it } from "vitest";
import { KnowledgeCsvError, parseKnowledgeCsv } from "./knowledge-csv";

describe("knowledge CSV import", () => {
  it("reads quoted commas, doubled quotes, CRLF and tags", () => {
    expect(
      parseKnowledgeCsv(
        'Title,Content,Category,Tags\r\n"A, B","Use ""care"".",case_study,"one|two"\r\n',
      ),
    ).toEqual([
      { title: "A, B", content: 'Use "care".', category: "case_study", tags: ["one", "two"] },
    ]);
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
