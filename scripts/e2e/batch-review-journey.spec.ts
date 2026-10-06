import { expect, test } from "@playwright/test";
import { submitSignup } from "./signup";

test.skip(
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: hosted acceptance owns its separate runner.
  process.env.PUBRICK_E2E_HOSTED === "1",
  "Batch review uses the disposable self-hosted stack.",
);
test.use({ actionTimeout: 10_000 });

test("mobile batch review requires every saved version and refuses a changed selection atomically", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("/en/signup");
  await page.getByLabel("Name", { exact: true }).fill("Batch editor");
  await page.getByLabel("Email", { exact: true }).fill("batch@browser.example");
  await page.getByLabel("Password", { exact: true }).fill("Disposable-batch-password-123!");
  await submitSignup(page);
  await page.getByLabel("Organization name").fill("Batch workspace");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page).toHaveURL(/\/en\/brands$/);
  await page.getByLabel("New brand name").fill("Batch studio");
  const createdBrand = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/brands",
  );
  await page.getByRole("button", { name: "Create brand", exact: true }).click();
  const brand: { id: string } = await (await createdBrand).json();
  // Any accidental delivery remains inside the owned fixture and fails its exact
  // request inventory. This scenario must never send or enqueue reviewed content.
  const createdChannel = await page.request.post("/api/channels", {
    data: {
      brandId: brand.id,
      platform: "telegram",
      name: "Batch journal",
      credentials: { botToken: "74001:pubrick_disposable_channel_only", chatId: "-1001234567890" },
    },
  });
  expect(createdChannel.ok()).toBeTruthy();
  const ids: string[] = [];
  for (const title of ["First selected story", "Second selected story"]) {
    await page.goto("/en/content/new");
    await page.getByLabel("Brand", { exact: true }).selectOption({ label: "Batch studio" });
    await page.getByRole("checkbox", { name: /Batch journal/ }).check();
    await page.getByLabel("Title", { exact: true }).fill(title);
    await page.getByLabel("Body", { exact: true }).fill(`${title}: the actual saved content.`);
    await page.getByRole("button", { name: "Create post", exact: true }).click();
    await expect(page).toHaveURL(/\/en\/content\/[a-f0-9-]+$/);
    const id = new URL(page.url()).pathname.split("/").at(-1);
    if (!id) throw new Error("Missing saved batch content");
    ids.push(id);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/en/content");
  const firstSelection = page.getByRole("checkbox", {
    name: "Select First selected story",
    exact: true,
  });
  await firstSelection.focus();
  await firstSelection.press("Space");
  await page.getByRole("checkbox", { name: "Select Second selected story", exact: true }).check();
  await expect(page.getByText("2 selected · up to 20", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Review", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Review selected posts", exact: true });
  await expect(dialog.getByText("Brand: Batch studio", { exact: true })).toBeVisible();
  const approve = dialog.getByRole("button", { name: "Approve", exact: true });
  await expect(approve).toBeDisabled();
  for (const title of ["First selected story", "Second selected story"]) {
    await expect(dialog.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await expect(
      dialog.getByText(`${title}: the actual saved content.`, { exact: true }).first(),
    ).toBeVisible();
    const acknowledge = dialog.getByRole("checkbox", {
      name: `I reviewed the saved version of “${title}” and each channel above.`,
      exact: true,
    });
    await acknowledge.focus();
    await acknowledge.press("Space");
    if (title === "First selected story") await expect(approve).toBeDisabled();
  }
  await expect(approve).toBeEnabled();
  expect((await approve.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  const updated = await page.request.patch(`/api/content/${ids[0]}`, {
    data: {
      body: "A newer saved story requires a fresh review.",
      expectedBody: "First selected story: the actual saved content.",
    },
  });
  expect(updated.ok()).toBeTruthy();
  const confirmed = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/api/brands/${brand.id}/content/batch-review/confirm`),
  );
  await approve.click();
  expect((await confirmed).status()).toBe(409);
  await expect(dialog.getByRole("alert")).toHaveText(
    "This selection changed. Reload and review the current versions.",
  );
  await expect(approve).toBeDisabled();
  await dialog.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(
    dialog.getByText("A newer saved story requires a fresh review.", { exact: true }).first(),
  ).toBeVisible();
  await expect(approve).toBeDisabled();
  for (const checkbox of await dialog.getByRole("checkbox").all())
    await expect(checkbox).not.toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: "/tmp/pubrick-batch-review-mobile.png", fullPage: true });
  await dialog
    .getByRole("button", { name: "Close", exact: true })
    .filter({ hasText: /^Close$/ })
    .click();
  for (const id of ids) {
    const response = await page.request.get(`/api/content/${id}`);
    expect(response.ok()).toBeTruthy();
    const saved = await response.json();
    expect(saved.status).toBe("draft");
    expect(saved.adaptations).toEqual([
      expect.objectContaining({ status: "pending", attemptCount: 0 }),
    ]);
  }
});
