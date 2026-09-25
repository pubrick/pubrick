import type { ContentImageDto } from "@pubrick/shared";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { buildVcPackage, vcArticleHtml } from "./vc-package";

const images: ContentImageDto[] = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    mediaId: "00000000-0000-4000-8000-000000000002",
    afterParagraph: 0,
    alt: 'A "sample" <photo> & details',
    caption: "O'Brien <said> hello",
    alignment: "right",
    needsReview: false,
  },
];

const article = {
  title: '<Heading> & "friends"',
  body: "First <script>alert('x')</script> paragraph.\nLine two.\n\nSecond paragraph.",
  masterBody: "First <script>alert('x')</script> paragraph.\nLine two.\n\nSecond paragraph.",
  images,
};

describe("VC.ru portable article package", () => {
  it("escapes user text and places saved images after the matching master paragraph", () => {
    const html = vcArticleHtml(article);
    expect(html).toContain("&lt;Heading&gt; &amp; &quot;friends&quot;");
    expect(html).toContain(
      "First &lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; paragraph.<br>Line two.",
    );
    expect(html).not.toContain("<script>");
    expect(html).toMatch(
      /<\/p>\n<figure style="max-width:32rem;margin:1.5rem 0 1.5rem auto"><img src="images\/01.jpg" alt="A &quot;sample&quot; &lt;photo&gt; &amp; details"/,
    );
    expect(html).toContain("<figcaption>O&#39;Brien &lt;said&gt; hello</figcaption>");
    expect(html.indexOf("<figure ")).toBeLessThan(html.indexOf("Second paragraph."));
  });

  it("does not pretend master paragraph positions apply to an adapted body", () => {
    const html = vcArticleHtml({ ...article, body: "New opening.\n\nAdapted second paragraph." });
    expect(html.indexOf("<figure ")).toBeGreaterThan(html.indexOf("Adapted second paragraph."));
    expect(html).toContain("The VC.ru adaptation differs from the main article.");
  });

  it("keeps indentation and trailing whitespace in reviewed paragraphs", () => {
    const body = "  First line.  \n\tSecond line. \n\n  Next paragraph.\t";
    const html = vcArticleHtml({ ...article, body, masterBody: body });
    expect(html).toContain("<p>  First line.  <br>\tSecond line. </p>");
    expect(html).toContain("<p>  Next paragraph.\t</p>");
    expect(html.indexOf("<figure ")).toBeLessThan(html.indexOf("Next paragraph."));
  });

  it("downloads authenticated JPEGs and writes a complete ZIP with placement guidance", async () => {
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const fetchImage = vi
      .fn()
      .mockResolvedValue(new Response(jpg, { headers: { "content-type": "image/jpeg" } }));
    const zip = await buildVcPackage(article, fetchImage);
    expect(fetchImage).toHaveBeenCalledWith(`/api/media/${images[0]?.mediaId}/file`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    const files = unzipSync(zip);
    expect(Object.keys(files).sort()).toEqual(["README.txt", "article.html", "images/01.jpg"]);
    expect(files["images/01.jpg"]).toEqual(jpg);
    expect(strFromU8(files["article.html"] ?? new Uint8Array())).toContain("<figure ");
    expect(strFromU8(files["README.txt"] ?? new Uint8Array())).toContain(
      "after paragraph 1 in the main article",
    );
    expect(strFromU8(files["README.txt"] ?? new Uint8Array())).toContain("alignment: right");
  });

  it("includes the saved cover and fetches it once when also used inline", async () => {
    const jpg = new Uint8Array([0xff, 0xd8, 0x12, 0xff, 0xd9]);
    const fetchImage = vi
      .fn()
      .mockResolvedValue(new Response(jpg, { headers: { "content-type": "image/jpeg" } }));
    const zip = await buildVcPackage({ ...article, coverMediaId: images[0]?.mediaId }, fetchImage);
    const files = unzipSync(zip);
    expect(fetchImage).toHaveBeenCalledTimes(1);
    expect(files["cover.jpg"]).toEqual(jpg);
    expect(files["images/01.jpg"]).toEqual(jpg);
    expect(strFromU8(files["README.txt"] ?? new Uint8Array())).toContain(
      "Upload cover.jpg as the VC.ru article cover",
    );
  });

  it.each([
    ["missing", new Response(null, { status: 404 })],
    ["not a JPEG", new Response("html", { headers: { "content-type": "text/html" } })],
  ])("refuses a package when the cover is %s", async (_case, response) => {
    const fetchImage = vi.fn().mockResolvedValue(response);
    await expect(
      buildVcPackage(
        { ...article, coverMediaId: "00000000-0000-4000-8000-000000000003" },
        fetchImage,
      ),
    ).rejects.toThrow();
    expect(fetchImage).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing", new Response(null, { status: 404 })],
    ["wrong media type", new Response("html", { headers: { "content-type": "text/html" } })],
    ["empty JPEG", new Response(null, { headers: { "content-type": "image/jpeg" } })],
  ])("fails the entire package when a JPEG is %s", async (_case, response) => {
    await expect(buildVcPackage(article, vi.fn().mockResolvedValue(response))).rejects.toThrow();
  });
});
