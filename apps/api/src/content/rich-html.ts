import { Logger } from "@nestjs/common";
import { projectRichBody, type RichBody, richBodySchema } from "@pubrick/shared";
import { renderJSONContentToString, serializeChildrenToHTMLString } from "@tiptap/static-renderer";
import { escape as escapeHtml } from "html-escaper";
import sanitizeHtml from "sanitize-html";

const render = renderJSONContentToString({
  nodeMapping: {
    doc: ({ children }) => serializeChildrenToHTMLString(children),
    paragraph: ({ children }) => `<p>${serializeChildrenToHTMLString(children)}</p>`,
    heading: ({ node, children }) =>
      node.attrs?.level === 3
        ? `<h3>${serializeChildrenToHTMLString(children)}</h3>`
        : `<h2>${serializeChildrenToHTMLString(children)}</h2>`,
    bulletList: ({ children }) => `<ul>${serializeChildrenToHTMLString(children)}</ul>`,
    orderedList: ({ node, children }) =>
      `<ol start="${Number(node.attrs?.start ?? 1)}">${serializeChildrenToHTMLString(children)}</ol>`,
    listItem: ({ children }) => `<li>${serializeChildrenToHTMLString(children)}</li>`,
    text: ({ node }) => escapeHtml(node.text ?? ""),
  },
  markMapping: {
    bold: ({ children }) => `<strong>${serializeChildrenToHTMLString(children)}</strong>`,
    italic: ({ children }) => `<em>${serializeChildrenToHTMLString(children)}</em>`,
    link: ({ mark, children }) =>
      `<a href="${escapeHtml(String(mark.attrs?.href ?? ""))}" rel="nofollow noopener noreferrer">${serializeChildrenToHTMLString(children)}</a>`,
  },
  unhandledNode: () => "",
  unhandledMark: () => "",
});

/** Stored JSON is revalidated at the public boundary and projected text must still agree. */
export function safeRichHtmlBlocks(value: unknown, body: string): string[] | null {
  if (value === null) return null;
  const result = richBodySchema.safeParse(value);
  if (!result.success || projectRichBody(result.data) !== body) {
    Logger.error("Invalid stored rich document; rendering escaped text", "RichHtml");
    return null;
  }
  return (result.data as RichBody).content.map((block) =>
    sanitizeHtml(render({ content: { type: "doc", content: [block] } }), {
      allowedTags: ["p", "h2", "h3", "ul", "ol", "li", "strong", "em", "a"],
      allowedAttributes: { a: ["href", "rel"], ol: ["start"] },
      allowedSchemes: ["http", "https", "mailto"],
      allowProtocolRelative: false,
    }),
  );
}
