import { JSDOM } from "jsdom";

const MAX_MATERIAL_CHARS = 12_000;

/** Convert a bounded HTML response into bounded, inert prompt material. */
export function websiteMaterial(html: string, url: string): string {
  const dom = new JSDOM(html, { url });
  try {
    const document = dom.window.document;
    for (const node of document.querySelectorAll("script, style, nav, footer, noscript, svg")) {
      node.remove();
    }
    const title = document.title;
    const description =
      document.querySelector('meta[name="description"]')?.getAttribute("content") ?? "";
    const headings = [...document.querySelectorAll("h1, h2")]
      .slice(0, 20)
      .map((node) => node.textContent ?? "")
      .join("\n");
    const body = document.body?.textContent ?? "";
    return [title, description, headings, body]
      .join("\n")
      .replaceAll("\u0000", "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_MATERIAL_CHARS);
  } finally {
    dom.window.close();
  }
}
