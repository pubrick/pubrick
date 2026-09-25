import type { ContentImageDto } from "@pubrick/shared";
import { strToU8, zipSync } from "fflate";
import { escape as escapeHtml } from "html-escaper";

type VcPackageInput = {
  title: string;
  body: string;
  masterBody: string;
  coverMediaId?: string | null;
  images: ContentImageDto[];
};

function paragraphHtml(paragraph: string): string {
  return `<p>${escapeHtml(paragraph).replace(/\r?\n/g, "<br>")}</p>`;
}

/** The reviewed adaptation is authoritative; paragraph positions belong to the master body. */
export function vcArticleHtml(input: VcPackageInput): string {
  // Match InlineImages' paragraph separator and nonempty ordinal while keeping
  // the reviewed block's actual leading/trailing whitespace in the HTML.
  const paragraphs = input.body.split(/\n\s*\n/).filter((paragraph) => paragraph.trim().length > 0);
  const positionsMatch = input.body === input.masterBody;
  const imageByPosition = new Map(
    input.images.map((image, index) => [image.afterParagraph, index]),
  );
  const article = paragraphs
    .map((paragraph, position) => {
      const paragraphMarkup = paragraphHtml(paragraph);
      const imageIndex = positionsMatch ? imageByPosition.get(position) : undefined;
      if (imageIndex === undefined) return paragraphMarkup;
      const image = input.images[imageIndex];
      if (!image) return paragraphMarkup;
      return `${paragraphMarkup}\n${figureHtml(image, imageIndex)}`;
    })
    .join("\n");
  const attachments =
    !positionsMatch && input.images.length > 0
      ? `\n<section><h2>Images to place manually</h2>\n<p>The VC.ru adaptation differs from the main article. These images are listed separately because their saved paragraph positions refer to the main article.</p>\n${input.images.map(figureHtml).join("\n")}\n</section>`
      : "";
  return `<!doctype html>\n<html lang="und">\n<head><meta charset="utf-8"><title>${escapeHtml(input.title)}</title><style>article p { white-space: pre-wrap; }</style></head>\n<body><article><h1>${escapeHtml(input.title)}</h1>\n${article}${attachments}\n</article></body>\n</html>\n`;
}

function figureHtml(image: ContentImageDto, index: number): string {
  const caption = image.caption ? `<figcaption>${escapeHtml(image.caption)}</figcaption>` : "";
  // Use fixed styles selected by the closed DTO enum; never interpolate an
  // arbitrary persisted value into portable HTML attributes.
  const margin = {
    left: "1.5rem auto 1.5rem 0",
    center: "1.5rem auto",
    right: "1.5rem 0 1.5rem auto",
  }[image.alignment];
  return `<figure style="max-width:32rem;margin:${margin}"><img src="images/${String(index + 1).padStart(2, "0")}.jpg" alt="${escapeHtml(image.alt)}" style="max-width:100%;height:auto">${caption}</figure>`;
}

/** Assemble only after every authenticated image request succeeds. No partial package is returned. */
export async function buildVcPackage(
  input: VcPackageInput,
  fetchImage: typeof fetch = fetch,
): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  const downloaded = new Map<string, Uint8Array>();
  async function jpeg(mediaId: string): Promise<Uint8Array> {
    const cached = downloaded.get(mediaId);
    if (cached) return cached;
    const response = await fetchImage(`/api/media/${mediaId}/file`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok || !response.headers.get("content-type")?.startsWith("image/jpeg")) {
      throw new Error("Could not download article image");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0) throw new Error("Article image is empty");
    downloaded.set(mediaId, bytes);
    return bytes;
  }
  if (input.coverMediaId) {
    files["cover.jpg"] = await jpeg(input.coverMediaId);
  }
  for (const [index, image] of input.images.entries()) {
    files[`images/${String(index + 1).padStart(2, "0")}.jpg`] = await jpeg(image.mediaId);
  }

  files["article.html"] = strToU8(vcArticleHtml(input));
  const guide = [
    "VC.ru manual publishing package",
    "",
    "Open article.html to review the approved title, text, and image captions.",
    "Copy the title and text into VC.ru and upload each JPEG yourself.",
    ...(input.coverMediaId
      ? ["Upload cover.jpg as the VC.ru article cover after reviewing it."]
      : []),
    "Pubrick does not publish to VC.ru or verify the result. Record the public URL in Pubrick after publishing.",
    "",
    input.body === input.masterBody
      ? "Images in article.html follow their saved paragraph positions."
      : "The VC.ru text differs from the main article. Images appear after the article, not at an assumed position. Place them in VC.ru after reviewing the adapted text.",
    ...input.images.map(
      (image, index) =>
        `images/${String(index + 1).padStart(2, "0")}.jpg — after paragraph ${image.afterParagraph + 1} in the main article; alignment: ${image.alignment}; alt: ${image.alt}${image.caption ? `; caption: ${image.caption}` : ""}`,
    ),
    "",
  ].join("\n");
  files["README.txt"] = strToU8(guide);
  return zipSync(files, { level: 0 });
}
