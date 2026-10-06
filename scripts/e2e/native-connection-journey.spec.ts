import { expect, test } from "@playwright/test";
import { submitSignup } from "./signup";

test.skip(
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: hosted acceptance owns a separate runner.
  process.env.PUBRICK_E2E_HOSTED === "1",
  "Native connection lifecycle uses the disposable self-hosted stack.",
);
test.use({ timezoneId: "UTC", actionTimeout: 10_000 });

test("WordPress destination and credential rotation preserve a future reviewed delivery", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("/en/signup");
  await page.getByLabel("Name", { exact: true }).fill("Native editor");
  await page.getByLabel("Email", { exact: true }).fill("native@browser.example");
  await page.getByLabel("Password", { exact: true }).fill("Disposable-native-password-123!");
  await submitSignup(page);
  await page.getByLabel("Organization name").fill("Native workspace");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page).toHaveURL(/\/en\/brands$/);
  await page.getByLabel("New brand name").fill("Publishing studio");
  const createdBrand = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/brands",
  );
  await page.getByRole("button", { name: "Create brand", exact: true }).click();
  const brand: { id: string } = await (await createdBrand).json();
  await page.goto(`/en/brands/${brand.id}`);
  await page.getByLabel("Platform", { exact: true }).selectOption("wordpress");
  await page.getByLabel("Channel name", { exact: true }).fill("Studio journal");
  await page
    .getByLabel("Site URL", { exact: true })
    .fill("https://journal.browser.example.com/studio");
  await page.getByLabel("Username", { exact: true }).fill("editor");
  await page
    .getByLabel("Application password", { exact: true })
    .fill("synthetic-original-password");
  const createdChannel = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/channels",
  );
  await page.getByRole("button", { name: "Add channel", exact: true }).click();
  const response = await createdChannel;
  expect(response.status()).toBe(201);
  const channel: { id: string; connectionTarget: string } = await response.json();
  expect(channel.connectionTarget).toBe("https://journal.browser.example.com/studio/");
  expect(JSON.stringify(channel)).not.toContain("synthetic-original-password");
  await expect(
    page.getByText(`Destination: ${channel.connectionTarget}`, { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Not checked", { exact: true })).toBeVisible();

  // These are synthetics, so never press Test or create a live WordPress record.
  await page.goto("/en/content/new");
  await page.getByLabel("Brand", { exact: true }).selectOption({ label: "Publishing studio" });
  await page.getByRole("checkbox", { name: /Studio journal/ }).check();
  await page.getByLabel("Title", { exact: true }).fill("An article for our journal");
  await page.getByLabel("Body", { exact: true }).fill("Saved human content for the journal.");
  await page.getByRole("button", { name: "Create post", exact: true }).click();
  await expect(page).toHaveURL(/\/en\/content\/[a-f0-9-]+$/);
  const itemId = new URL(page.url()).pathname.split("/").at(-1);
  if (!itemId) throw new Error("Missing browser content ID");
  const nextDay = new Date(Date.now() + 86_400_000);
  nextDay.setUTCHours(16, 0, 0, 0);
  await page
    .getByLabel("Or schedule for", { exact: true })
    .fill(nextDay.toISOString().slice(0, 16));
  const approved = page.waitForResponse(
    (result) =>
      result.request().method() === "POST" &&
      result.url().endsWith(`/api/content/${itemId}/approve`),
  );
  await page.getByRole("button", { name: "Approve with schedule", exact: true }).click();
  expect((await approved).ok()).toBeTruthy();
  const readDelivery = async () => {
    const result = await page.request.get(`/api/content/${itemId}`);
    expect(result.ok()).toBeTruthy();
    const item = await result.json();
    return item.adaptations;
  };
  const original = await readDelivery();
  expect(original).toEqual([
    expect.objectContaining({
      channelId: channel.id,
      status: "scheduled",
      scheduledAt: nextDay.toISOString(),
    }),
  ]);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/en/brands/${brand.id}`);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Edit channel", exact: true });
  for (const field of ["Site URL", "Username", "Application password"]) {
    await expect(dialog.getByLabel(field, { exact: true })).toHaveValue("");
  }
  await dialog
    .getByLabel("Site URL", { exact: true })
    .fill("https://different.browser.example.com/studio/");
  await dialog.getByLabel("Username", { exact: true }).fill("editor");
  await dialog
    .getByLabel("Application password", { exact: true })
    .fill("synthetic-replacement-password");
  const refused = page.waitForResponse(
    (result) =>
      result.request().method() === "PATCH" && result.url().endsWith(`/api/channels/${channel.id}`),
  );
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  expect((await refused).status()).toBe(409);
  await expect(dialog.getByRole("alert")).toContainText("different destination");
  expect(await readDelivery()).toEqual(original);
  await dialog.getByLabel("Site URL", { exact: true }).fill(channel.connectionTarget);
  const rotated = page.waitForResponse(
    (result) =>
      result.request().method() === "PATCH" && result.url().endsWith(`/api/channels/${channel.id}`),
  );
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  expect((await rotated).ok()).toBeTruthy();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByText(`Destination: ${channel.connectionTarget}`, { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Not checked", { exact: true })).toBeVisible();
  expect(await readDelivery()).toEqual(original);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: "/tmp/pubrick-wordpress-connection-mobile.png", fullPage: true });
});
