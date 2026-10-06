import { expect, test } from "@playwright/test";
import { submitSignup } from "./signup";

test.skip(
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: hosted acceptance owns its separate runner.
  process.env.PUBRICK_E2E_HOSTED === "1",
  "Team review uses the disposable self-hosted stack.",
);
test.use({ actionTimeout: 10_000 });

test("responsibility preserves composer edits and a mobile guest reviews only saved versions", async ({
  page,
  browser,
}) => {
  test.setTimeout(150_000);
  await page.goto("/en/signup");
  await page.getByLabel("Name", { exact: true }).fill("Studio editor");
  await page.getByLabel("Email", { exact: true }).fill("review@browser.example");
  await page.getByLabel("Password", { exact: true }).fill("Disposable-review-password-123!");
  await submitSignup(page);
  await page.getByLabel("Organization name").fill("Review workspace");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page).toHaveURL(/\/en\/brands$/);
  await page.getByLabel("New brand name").fill("Review studio");
  const createdBrand = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/brands",
  );
  await page.getByRole("button", { name: "Create brand", exact: true }).click();
  const brand: { id: string } = await (await createdBrand).json();
  const channel = await page.request.post("/api/channels", {
    data: { brandId: brand.id, platform: "vc_ru", name: "Studio journal" },
  });
  expect(channel.ok()).toBeTruthy();
  await page.goto("/en/content/new");
  await page.getByLabel("Brand", { exact: true }).selectOption({ label: "Review studio" });
  await page.getByRole("checkbox", { name: /Studio journal/ }).check();
  await page.getByLabel("Title", { exact: true }).fill("Our studio's first story");
  await page.getByLabel("Body", { exact: true }).fill("The saved master story for our client.");
  await page.getByRole("button", { name: "Create post", exact: true }).click();
  await expect(page).toHaveURL(/\/en\/content\/[a-f0-9-]+$/);
  const itemId = new URL(page.url()).pathname.split("/").at(-1);
  if (!itemId) throw new Error("Missing created review item");
  const override = page.getByLabel("Override for VC.ru · Studio journal", { exact: true });
  await override.fill("The channel story our client should review.");
  const share = page.getByRole("button", { name: "Create review link", exact: true });
  await expect(share).toBeDisabled();
  await expect(
    page.getByText(
      "Save your changes before creating a review link. The client reviews the saved version.",
    ),
  ).toBeVisible();

  const responsibility = page.getByRole("region", { name: "Responsibility", exact: true });
  await responsibility.getByLabel("Responsible person", { exact: true }).selectOption({
    label: "Studio editor",
  });
  await responsibility.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    responsibility.getByText("Assigned to Studio editor", { exact: true }),
  ).toBeVisible();
  await expect(override).toHaveValue("The channel story our client should review.");
  await expect(share).toBeDisabled();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(share).toBeEnabled();
  await share.click();
  const firstLink = await page.getByTestId("client-review-link").innerText();

  // A separate context proves that a client needs neither a Pubrick account nor workspace cookies.
  const guestContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const guest = await guestContext.newPage();
    await guest.goto(firstLink);
    await expect(
      guest.getByRole("heading", { name: "Our studio's first story", exact: true }),
    ).toBeVisible();
    await expect(
      guest.getByText("The saved master story for our client.", { exact: true }),
    ).toBeVisible();
    await expect(
      guest.getByText("The channel story our client should review.", { exact: true }),
    ).toBeVisible();
    await guest.getByRole("button", { name: "Request changes", exact: true }).click();
    await expect(
      guest.getByRole("alert").filter({ hasText: "Tell the team what needs to change." }),
    ).toBeVisible();
    await guest
      .getByLabel("Comment (optional when approving)", { exact: true })
      .fill("Make the channel ending more personal.");
    await guest.getByRole("button", { name: "Request changes", exact: true }).click();
    await expect(
      guest.getByRole("heading", { name: "Changes requested", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Refresh client response", exact: true }).click();
    await expect(page.getByText("Client requested changes", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Make the channel ending more personal.", { exact: true }),
    ).toBeVisible();

    await override.fill("A more personal channel story, saved for the second review.");
    const replace = page.getByRole("button", { name: "Create a new link", exact: true });
    await expect(replace).toBeDisabled();
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(replace).toBeEnabled();
    await guest.reload();
    await expect(
      guest.getByRole("heading", { name: "This review link is closed", exact: true }),
    ).toBeVisible();
    await replace.click();
    const secondLink = await page.getByTestId("client-review-link").innerText();
    expect(secondLink).not.toBe(firstLink);
    await guest.goto(secondLink);
    await expect(
      guest.getByText("A more personal channel story, saved for the second review.", {
        exact: true,
      }),
    ).toBeVisible();
    const approve = guest.getByRole("button", { name: "Approve draft", exact: true });
    expect((await approve.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await approve.focus();
    await approve.press("Enter");
    await expect(
      guest.getByRole("heading", { name: "Approval recorded", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Refresh client response", exact: true }).click();
    await expect(page.getByText("Client approved this exact draft", { exact: true })).toBeVisible();
    const read = await page.request.get(`/api/content/${itemId}`);
    expect(read.ok()).toBeTruthy();
    const item = await read.json();
    expect(item.status).toBe("draft");
    expect(item.adaptations).toEqual([
      expect.objectContaining({
        status: "pending",
        body: "A more personal channel story, saved for the second review.",
      }),
    ]);
    expect(
      await guest.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await guest.screenshot({ path: "/tmp/pubrick-guest-review-mobile.png", fullPage: true });
    await page.getByRole("button", { name: "Revoke link", exact: true }).click();
    await expect(page.getByText("Review link revoked", { exact: true })).toBeVisible();
    await guest.reload();
    await expect(
      guest.getByRole("heading", { name: "This review link is closed", exact: true }),
    ).toBeVisible();
  } finally {
    await guestContext.close();
  }
});
