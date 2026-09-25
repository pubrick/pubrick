import { Controller, Get, Header, Param, ParseUUIDPipe, Res } from "@nestjs/common";
import { AllowAnonymous } from "@thallesp/nestjs-better-auth";
import type { Response } from "express";
import { Feed } from "feed";
import { escape as escapeHtml } from "html-escaper";
import { safeRichHtmlBlocks } from "../content/rich-html";
import { env } from "../env";
import { MediaRepository } from "../media/media.repository";
import { FeedsRepository } from "./feeds.repository";

function articleUrl(orgId: string, token: string, id: string): string {
  const base = env.WEB_ORIGIN.replace(/\/$/, "");
  return `${base}/api/feeds/${encodeURIComponent(orgId)}/${token}/articles/${id}`;
}

type InlineImage = {
  id: string;
  afterParagraph: number;
  alt: string;
  caption: string | null;
  alignment: "left" | "center" | "right";
};

function imageUrl(orgId: string, token: string, entryId: string, imageId: string): string {
  return `${env.WEB_ORIGIN.replace(/\/$/, "")}/api/feeds/${encodeURIComponent(orgId)}/${token}/articles/${entryId}/images/${imageId}`;
}

function paragraphs(
  text: string,
  images: InlineImage[] = [],
  orgId?: string,
  token?: string,
  entryId?: string,
  richBody?: unknown,
): string {
  const richBlocks = safeRichHtmlBlocks(richBody ?? null, text);
  const blocks =
    richBlocks ??
    text
      .split(/\n\s*\n/)
      .filter((paragraph) => paragraph.trim().length > 0)
      .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`);
  return blocks
    .map((copy, index) => {
      if (!orgId || !token || !entryId) return copy;
      const figures = images
        .filter((image) => image.afterParagraph === index)
        .map((image) => {
          const caption = image.caption
            ? `<figcaption>${escapeHtml(xmlSafe(image.caption))}</figcaption>`
            : "";
          const margin = {
            left: "1.5rem auto 1.5rem 0",
            center: "1.5rem auto",
            right: "1.5rem 0 1.5rem auto",
          }[image.alignment];
          return `<figure style="max-width:32rem;margin:${margin}"><img src="${escapeHtml(imageUrl(orgId, token, entryId, image.id))}" alt="${escapeHtml(xmlSafe(image.alt))}" loading="lazy">${caption}</figure>`;
        })
        .join("");
      return copy + figures;
    })
    .join("\n");
}

/** XML 1.0 Char production; `feed` escapes markup but preserves forbidden scalars. */
function xmlSafe(text: string): string {
  return Array.from(text)
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return (
        code === 0x9 ||
        code === 0xa ||
        code === 0xd ||
        (code >= 0x20 && code <= 0xd7ff) ||
        (code >= 0xe000 && code <= 0xfffd) ||
        (code >= 0x10000 && code <= 0x10ffff)
      );
    })
    .join("");
}

/** The feed and its article links are intentionally public only after a member opts in. */
@Controller("feeds/:orgId/:token")
@AllowAnonymous()
export class PublicFeedsController {
  constructor(
    private readonly feeds: FeedsRepository,
    private readonly media: MediaRepository,
  ) {}

  @Get("rss")
  @Header("Content-Type", "application/rss+xml; charset=utf-8")
  @Header("Cache-Control", "no-store")
  async rss(@Param("orgId") orgId: string, @Param("token") token: string) {
    const data = await this.feeds.publicFeed(orgId, token);
    const feed = new Feed({
      title: xmlSafe(data.brandName),
      description: xmlSafe(data.brandDescription ?? `${data.brandName} posts`),
      id: data.url,
      link: data.url,
      language: xmlSafe(data.language),
      feedLinks: { rss: data.url },
      generator: "Pubrick",
    });
    for (const entry of data.entries) {
      const url = articleUrl(orgId, token, entry.id);
      feed.addItem({
        id: url,
        link: url,
        title: xmlSafe(entry.title),
        date: entry.publishedAt,
        description: xmlSafe(entry.body.slice(0, 280)),
        content: paragraphs(
          xmlSafe(entry.body),
          entry.images,
          orgId,
          token,
          entry.id,
          entry.richBody,
        ),
      });
    }
    return feed.rss2();
  }

  @Get("articles/:entryId")
  @Header("Content-Type", "text/html; charset=utf-8")
  @Header(
    "Content-Security-Policy",
    "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
  )
  @Header("Cache-Control", "no-store")
  async article(
    @Param("orgId") orgId: string,
    @Param("token") token: string,
    @Param("entryId", ParseUUIDPipe) entryId: string,
  ) {
    const article = await this.feeds.publicArticle(orgId, token, entryId);
    return `<!doctype html><html lang="${escapeHtml(article.language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(article.title)}</title><style>body{max-width:42rem;margin:3rem auto;padding:0 1.25rem;font:1.1rem/1.65 system-ui,sans-serif;color:#21201e}h1{line-height:1.2}small{color:#625e5a}figure img{display:block;max-width:100%;height:auto;border-radius:.4rem}figcaption{font-size:.9rem;color:#625e5a;margin-top:.4rem}</style></head><body><main><small>${escapeHtml(article.brandName)} · ${article.publishedAt.toISOString().slice(0, 10)}</small><h1>${escapeHtml(article.title)}</h1>${paragraphs(article.body, article.images, orgId, token, entryId, article.richBody)}</main></body></html>`;
  }

  @Get("articles/:entryId/images/:imageId")
  @Header("Cache-Control", "no-store")
  async image(
    @Param("orgId") orgId: string,
    @Param("token") token: string,
    @Param("entryId", ParseUUIDPipe) entryId: string,
    @Param("imageId", ParseUUIDPipe) imageId: string,
    @Res() response: Response,
  ): Promise<void> {
    const mediaId = await this.feeds.publicImage(orgId, token, entryId, imageId);
    const asset = await this.media.fileForStream(orgId, mediaId);
    if (asset.kind !== "image") {
      response.status(404).end();
      return;
    }
    response.setHeader("Content-Type", "image/jpeg");
    response.setHeader("Content-Disposition", "inline");
    response.setHeader("X-Content-Type-Options", "nosniff");
    await new Promise<void>((resolve) => {
      response.sendFile(asset.path, { dotfiles: "allow" }, (error) => {
        if (error && !response.headersSent) response.status(404).end();
        resolve();
      });
    });
  }
}
