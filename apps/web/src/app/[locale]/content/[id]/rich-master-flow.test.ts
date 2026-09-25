import { projectRichBody, richBodySchema } from "@pubrick/shared";
import { Editor } from "@tiptap/react";
import { describe, expect, it } from "vitest";
import { richMasterExtensions } from "./rich-master-editor";
import { hasRichApiSupport, richDocumentFromPlainText } from "./rich-master-flow";

describe("rich editor admission", () => {
  it("preserves exact plain channel text during conversion", () => {
    const document = richDocumentFromPlainText("Café ☕\n\nSecond line");
    expect(document?.content).toHaveLength(2);
    expect(richDocumentFromPlainText("a\n\nb\n\n")).not.toBeNull();
    const withSingleNewline = richDocumentFromPlainText("First\nsecond");
    expect(withSingleNewline).not.toBeNull();
    const editor = new Editor({ extensions: richMasterExtensions, content: withSingleNewline });
    const parsed = richBodySchema.parse(editor.getJSON());
    expect(projectRichBody(parsed)).toBe("First\nsecond");
    editor.destroy();
  });

  it("refuses a document outside the bounded schema and detects older APIs", () => {
    expect(richDocumentFromPlainText("x\n\n".repeat(300))).toBeNull();
    expect(hasRichApiSupport({ bodyRevision: 0, richBody: null })).toBe(true);
    expect(hasRichApiSupport({ bodyRevision: 0 })).toBe(false);
  });
});
