import { Editor } from "@tiptap/react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { RichMasterEditor, richMasterExtensions } from "./rich-master-editor";

const initialDocument = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "A quiet harbor" }] }],
};

describe("rich master authoring surface", () => {
  it("registers only the supported document vocabulary", () => {
    const editor = new Editor({ extensions: richMasterExtensions });
    expect(Object.keys(editor.schema.nodes).sort()).toEqual(
      ["bulletList", "doc", "heading", "listItem", "orderedList", "paragraph", "text"].sort(),
    );
    expect(Object.keys(editor.schema.marks).sort()).toEqual(["bold", "italic", "link"]);
    editor.commands.setContent("<h1>Unsupported level</h1>");
    expect(editor.getJSON().content?.[0]?.type).toBe("paragraph");
    editor.destroy();
  });

  it("does not accept script links or external image nodes from pasted HTML", () => {
    const editor = new Editor({ extensions: richMasterExtensions });
    editor.commands.setContent(
      '<p><a href="javascript:alert(1)">unsafe</a> <a href="https://example.org" onclick="alert(1)">safe</a><img src="https://example.org/pixel"></p>',
    );
    const document = editor.getJSON();
    expect(JSON.stringify(document)).not.toContain("javascript:");
    expect(JSON.stringify(document)).not.toContain("pixel");
    expect(JSON.stringify(document)).not.toContain("onclick");
    expect(JSON.stringify(document)).toContain("https://example.org");
    editor.destroy();
  });

  it("exposes a labelled keyboard-editable field without changing the text draft path", async () => {
    render(<RichMasterEditor initialDocument={initialDocument} onChange={vi.fn()} />);
    const textbox = await screen.findByRole("textbox", { name: "Formatted master draft" });
    expect(textbox).toHaveAttribute("contenteditable", "true");
    expect(textbox).toHaveTextContent("A quiet harbor");
    expect(screen.queryByRole("button", { name: "Save body" })).not.toBeInTheDocument();
  });

  it("opens the link control with the keyboard and refuses an unsafe URL", async () => {
    render(<RichMasterEditor initialDocument={initialDocument} onChange={vi.fn()} />);
    const textbox = await screen.findByRole("textbox", { name: "Formatted master draft" });
    fireEvent.keyDown(textbox, { key: "k", ctrlKey: true });
    const linkInput = screen.getByRole("textbox", { name: "Link URL" });
    fireEvent.change(linkInput, { target: { value: "javascript:alert(1)" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply link" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter an HTTP, HTTPS, or email link.");
    expect(linkInput).toHaveAttribute("aria-invalid", "true");
  });

  it("disables editing when the master is read only", async () => {
    render(<RichMasterEditor initialDocument={initialDocument} onChange={vi.fn()} readOnly />, {
      locale: "ru",
    });
    const textbox = await screen.findByRole("textbox", {
      name: "Форматированный основной черновик",
    });
    expect(textbox).toHaveAttribute("contenteditable", "false");
  });
});
