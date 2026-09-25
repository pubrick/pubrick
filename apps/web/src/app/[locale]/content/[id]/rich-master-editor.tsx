"use client";

import type { JSONContent } from "@tiptap/react";
import { EditorContent, useEditor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import StarterKit from "@tiptap/starter-kit";
import { useTranslations } from "next-intl";
import { useState } from "react";

/**
 * The browser is deliberately only an authoring surface. The API owns the
 * allowlist, projection, revision check, and rendering of this JSON. Do not
 * mount this editor as a save path until the rich-body API advertises support.
 */
export const richMasterExtensions = [
  StarterKit.configure({
    heading: { levels: [2, 3] },
    blockquote: false,
    code: false,
    codeBlock: false,
    hardBreak: false,
    horizontalRule: false,
    strike: false,
    underline: false,
    link: {
      autolink: false,
      linkOnPaste: false,
      openOnClick: false,
      HTMLAttributes: { target: null, rel: "noopener noreferrer" },
      isAllowedUri: (value, { defaultValidate }) =>
        defaultValidate(value) && /^(https?:|mailto:)/i.test(value),
    },
  }),
];

export type RichMasterEditorProps = {
  initialDocument: JSONContent;
  onChange: (document: JSONContent) => void;
  readOnly?: boolean;
};

export function RichMasterEditor({
  initialDocument,
  onChange,
  readOnly = false,
}: RichMasterEditorProps) {
  const t = useTranslations("Publish.richEditor");
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState("");
  const [linkError, setLinkError] = useState(false);
  const editor = useEditor({
    extensions: richMasterExtensions,
    content: initialDocument,
    editable: !readOnly,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-label": t("label"),
        "aria-multiline": "true",
        class:
          "min-h-48 w-full rounded-control border border-border-strong bg-panel px-4 py-3 text-sm leading-relaxed text-fg outline-none focus-visible:ring-2 focus-visible:ring-accent [&_h2]:mb-2 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mb-2 [&_h3]:text-lg [&_h3]:font-semibold [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-6 [&_ol]:pl-6 [&_a]:underline",
      },
      handleKeyDown: (_view, event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
          event.preventDefault();
          setLinkOpen(true);
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: current }) => onChange(current.getJSON()),
  });

  if (!editor) return null;

  function applyLink() {
    if (!editor) return;
    const value = linkValue.trim();
    if (!/^(https?:\/\/|mailto:)/i.test(value)) {
      setLinkError(true);
      return;
    }
    editor.chain().focus().setLink({ href: value }).run();
    setLinkOpen(false);
    setLinkError(false);
    setLinkValue("");
  }

  const buttonClass =
    "rounded-control px-2 py-1 text-sm text-fg-secondary hover:bg-bg-sunken focus-visible:outline-2 focus-visible:outline-accent aria-pressed:bg-accent-soft";

  return (
    <div>
      {!readOnly && (
        <BubbleMenu
          editor={editor}
          shouldShow={({ editor: current }) => !current.state.selection.empty}
        >
          <div
            className="flex flex-wrap gap-1 rounded-card border border-border bg-panel p-1 shadow-popover"
            role="toolbar"
            aria-label={t("formatting")}
          >
            <button
              type="button"
              className={buttonClass}
              aria-label={t("bold")}
              aria-pressed={editor.isActive("bold")}
              onClick={() => editor.chain().focus().toggleBold().run()}
            >
              B
            </button>
            <button
              type="button"
              className={buttonClass}
              aria-label={t("italic")}
              aria-pressed={editor.isActive("italic")}
              onClick={() => editor.chain().focus().toggleItalic().run()}
            >
              I
            </button>
            <button
              type="button"
              className={buttonClass}
              aria-label={t("heading2")}
              aria-pressed={editor.isActive("heading", { level: 2 })}
              onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
            >
              H2
            </button>
            <button
              type="button"
              className={buttonClass}
              aria-label={t("heading3")}
              aria-pressed={editor.isActive("heading", { level: 3 })}
              onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
            >
              H3
            </button>
            <button
              type="button"
              className={buttonClass}
              aria-label={t("bulletList")}
              aria-pressed={editor.isActive("bulletList")}
              onClick={() => editor.chain().focus().toggleBulletList().run()}
            >
              •
            </button>
            <button
              type="button"
              className={buttonClass}
              aria-label={t("orderedList")}
              aria-pressed={editor.isActive("orderedList")}
              onClick={() => editor.chain().focus().toggleOrderedList().run()}
            >
              1.
            </button>
            <button
              type="button"
              className={buttonClass}
              aria-label={t("link")}
              aria-pressed={editor.isActive("link")}
              onClick={() => setLinkOpen(true)}
            >
              {t("link")}
            </button>
          </div>
        </BubbleMenu>
      )}
      <EditorContent editor={editor} />
      {linkOpen && !readOnly && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-sm text-fg-secondary">
            {t("linkUrl")}
            <input
              type="url"
              value={linkValue}
              onChange={(event) => {
                setLinkValue(event.target.value);
                setLinkError(false);
              }}
              className="rounded-control border border-border-strong bg-panel px-3 py-2 text-fg"
              aria-invalid={linkError}
            />
          </label>
          <button type="button" className={buttonClass} onClick={applyLink}>
            {t("applyLink")}
          </button>
          <button
            type="button"
            className={buttonClass}
            onClick={() => {
              setLinkOpen(false);
              setLinkError(false);
            }}
          >
            {t("cancel")}
          </button>
          {linkError && (
            <p role="alert" className="w-full text-sm text-danger">
              {t("invalidLink")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
