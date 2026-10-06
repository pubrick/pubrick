import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

test.skip(
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: hosted acceptance owns a separate runner.
  process.env.PUBRICK_E2E_HOSTED === "1",
  "Publication results use the disposable self-hosted stack.",
);
test.use({ timezoneId: "UTC", actionTimeout: 10_000 });

test("human publication receipt appears in mobile results and a complete CSV", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/en/signup");
  await page.getByLabel("Name", { exact: true }).fill("Results editor");
  await page.getByLabel("Email", { exact: true }).fill("results@browser.example");
  await page.getByLabel("Password", { exact: true }).fill("Disposable-results-password-123!");
  await page.getByRole("button", { name: "Sign up", exact: true }).click();
  await page.getByLabel("Organization name").fill("Results workspace");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page).toHaveURL(/\/en\/brands$/);
  await page.getByLabel("New brand name").fill("Results studio");
  const createdBrand = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/brands",
  );
  await page.getByRole("button", { name: "Create brand", exact: true }).click();
  const brand: { id: string } = await (await createdBrand).json();
  await page.goto(`/en/brands/${brand.id}`);
  await page.getByLabel("Platform", { exact: true }).selectOption("vc_ru");
  await page.getByLabel("Channel name", { exact: true }).fill("Studio journal");
  const createdChannel = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/channels",
  );
  await page.getByRole("button", { name: "Add channel", exact: true }).click();
  const channel: { id: string } = await (await createdChannel).json();

  await page.goto("/en/content/new");
  await page.getByLabel("Brand", { exact: true }).selectOption({ label: "Results studio" });
  await page.getByRole("checkbox", { name: /Studio journal/ }).check();
  await page.getByLabel("Title", { exact: true }).fill('A reviewed "creative" article');
  await page
    .getByLabel("Body", { exact: true })
    .fill("Saved human content for results acceptance.");
  await page.getByRole("button", { name: "Create post", exact: true }).click();
  await expect(page).toHaveURL(/\/en\/content\/[a-f0-9-]+$/);
  await page.getByRole("button", { name: "Approve and prepare", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Ready for manual publishing", exact: true }),
  ).toBeDisabled();
  // This records a synthetic human assertion only. The suite never opens VC.ru,
  // sends to the provider or treats this assertion as a provider confirmation.
  await page
    .getByLabel("Published VC.ru post URL", { exact: true })
    .fill("https://vc.ru/id12345/999999");
  const recorded = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().includes("/manual-publication"),
  );
  await page.getByRole("button", { name: "Record publication", exact: true }).click();
  expect((await recorded).ok()).toBeTruthy();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/en/brands/${brand.id}/analytics`);
  const results = page.getByRole("region", { name: "Publication results", exact: true });
  await expect(results.getByText('A reviewed "creative" article', { exact: true })).toBeVisible();
  await expect(results.getByText("Confirmed by a person", { exact: true })).toBeVisible();
  const channelFilter = results.getByLabel("Channel", { exact: true });
  await expect(channelFilter).toBeEnabled();
  await channelFilter.selectOption(channel.id);
  await expect(results.getByText('A reviewed "creative" article', { exact: true })).toBeVisible();
  const downloaded = page.waitForEvent("download");
  await results.getByRole("button", { name: "Export CSV", exact: true }).click();
  const download = await downloaded;
  expect(await download.failure()).toBeNull();
  expect(download.suggestedFilename()).toBe("pubrick-publication-results.csv");
  const path = await download.path();
  if (!path) throw new Error("Missing results CSV download");
  const csv = await readFile(path, "utf8");
  expect(csv).toContain("publication_id,recorded_at,title,channel,platform,archived,asserted_at");
  expect(csv).toContain('"A reviewed ""creative"" article"');
  expect(csv).toContain("Studio journal,vc_ru,false");
  expect(csv).toContain("https://vc.ru/id12345/999999");
  expect(csv).not.toContain("Saved human content for results acceptance.");
  expect(
    await channelFilter.evaluate((node) => node.getBoundingClientRect().height),
  ).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: "/tmp/pubrick-publication-results-mobile.png", fullPage: true });
});
