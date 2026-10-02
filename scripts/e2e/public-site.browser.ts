import { expect, test } from "@playwright/test";

const PUBLIC_PAGES = ["", "product", "use-cases", "open-source", "hosting", "docs"] as const;

test("public pages render without login, retain localized navigation and expose only public SEO URLs", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  const writes: string[] = [];
  page.on("request", (req) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method())) writes.push(req.url());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 375, height: 812 });
  const titles = new Set<string>();
  for (const locale of ["en", "es", "ru", "pt"]) {
    for (const path of PUBLIC_PAGES) {
      const route = `/${locale}${path ? `/${path}` : ""}`;
      const response = await page.goto(route);
      expect(response?.status()).toBe(200);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      const title = await page.title();
      expect(titles.has(title)).toBe(false);
      titles.add(title);
      const canonical = await page.locator('link[rel="canonical"]').getAttribute("href");
      expect(canonical).toBe(`https://studio.example${route}`);
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "index, follow");
      await expect(page.locator('link[rel="alternate"][hreflang="x-default"]')).toHaveAttribute(
        "href",
        `https://studio.example/en${path ? `/${path}` : ""}`,
      );
      await expect(page.locator('a[lang="en"]')).toHaveAttribute(
        "href",
        `/en${path ? `/${path}` : ""}`,
      );
      await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
        "content",
        "https://studio.example/social-card.png",
      );
      expect(await page.locator("body").innerText()).not.toMatch(
        /Marketing\.|INSUFFICIENT_PATH|MISSING_MESSAGE/,
      );
    }
  }
  await page.goto("/en/product");
  await page.getByRole("link", { name: "Русский", exact: true }).click();
  await expect(page).toHaveURL(/\/ru\/product$/);
  await page.getByRole("link", { name: "English", exact: true }).click();
  await expect(page).toHaveURL(/\/en\/product$/);
  await page.goto("/en");
  const skip = page.getByRole("link", { name: "Skip to content", exact: true });
  expect(await skip.evaluate((el) => getComputedStyle(el).clipPath)).toBe("inset(50%)");
  await page.keyboard.press("Tab");
  await expect(skip).toBeFocused();
  expect(await skip.evaluate((el) => getComputedStyle(el).clipPath)).toBe("none");
  await skip.press("Enter");
  await expect(page.locator("#main")).toBeFocused();
  const opening = page.getByLabel("Content preview", { exact: true });
  const proposal = await opening.inputValue();
  await opening.fill("We brought unfinished work into the room. This is my version.");
  await expect(page.getByText("You have changed the proposal.", { exact: true })).toBeVisible();
  await page.getByLabel("Highlight unchanged proposal text", { exact: true }).check();
  await page.getByRole("button", { name: "Reset example", exact: true }).click();
  await expect(opening).toHaveValue(proposal);
  await expect(page.getByText("The proposal is unchanged.", { exact: true })).toBeVisible();
  expect(writes).toEqual([]);
  await page.screenshot({ path: ".data/public-site-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: ".data/public-site-desktop.png", fullPage: true });
  await page.evaluate(() => localStorage.setItem("pubrick-theme", "dark"));
  await page.reload();
  await page.screenshot({ path: ".data/public-site-dark.png", fullPage: true });
  const unknown = await request.get("/en/unknown-public-page");
  expect(unknown.status()).toBe(404);
  const robots = await request.get("/robots.txt");
  expect(await robots.text()).toContain("Allow: /en/product$");
  const sitemap = await request.get("/sitemap.xml");
  const xml = await sitemap.text();
  expect(xml.match(/<loc>/g)).toHaveLength(24);
  expect(xml).not.toMatch(/\/(login|signup|settings|content|brands|review)/);
  expect((await request.get("/social-card.png")).status()).toBe(200);
  expect(errors).toEqual([]);
});
