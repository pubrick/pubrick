import { expect, test } from "@playwright/test";
import { submitSignup } from "./signup";

test.skip(
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: hosted acceptance owns a separate runner.
  process.env.PUBRICK_E2E_HOSTED === "1",
  "Inbox onboarding uses the disposable self-hosted stack.",
);
test.use({ timezoneId: "UTC", actionTimeout: 10_000 });

test("a new editor discovers the supported inbox and recovers through Telegram account setup", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("/en/signup");
  await page.getByLabel("Name", { exact: true }).fill("Inbox editor");
  await page.getByLabel("Email", { exact: true }).fill("inbox@browser.example");
  await page.getByLabel("Password", { exact: true }).fill("Disposable-inbox-password-123!");
  await submitSignup(page);
  await page.getByLabel("Organization name").fill("Inbox workspace");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page).toHaveURL(/\/en\/brands$/);
  await page.getByLabel("New brand name").fill("Conversation studio");
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/brands",
  );
  await page.getByRole("button", { name: "Create brand", exact: true }).click();
  const brand: { id: string } = await (await created).json();
  await page.goto(`/en/brands/${brand.id}`);
  await page.getByRole("link", { name: "Inbox", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/en/brands/${brand.id}/inbox$`));
  await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
  await expect(
    page.getByText(/Direct messages, media-only replies and protected messages/),
  ).toBeVisible();
  await expect(page.getByText(/No collected discussions match this view/)).toBeVisible();
  await expect(page.getByText(/Connect a Telegram user account/)).toBeVisible();
  expect(await page.getByRole("button", { name: "Send reply", exact: true }).count()).toBe(0);

  await page.setViewportSize({ width: 390, height: 844 });
  const open = page.getByRole("tab", { name: "Open", exact: true });
  await open.focus();
  const resolvedResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/brands/${brand.id}/inbox` &&
      new URL(response.url()).searchParams.get("filter") === "resolved",
  );
  await page.keyboard.press("ArrowRight");
  expect((await resolvedResponse).ok()).toBeTruthy();
  const resolved = page.getByRole("tab", { name: "Resolved", exact: true });
  await expect(resolved).toBeFocused();
  await expect(resolved).toHaveAttribute("aria-selected", "true");
  const allResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/brands/${brand.id}/inbox` &&
      new URL(response.url()).searchParams.get("filter") === "all",
  );
  await page.keyboard.press("ArrowRight");
  expect((await allResponse).ok()).toBeTruthy();
  await expect(page.getByRole("tab", { name: "All", exact: true })).toBeFocused();

  const discovery = page.getByRole("button", { name: "Choose a publication", exact: true });
  const publications = page.waitForResponse(
    (response) => new URL(response.url()).pathname === `/api/brands/${brand.id}/inbox/publications`,
  );
  await discovery.click();
  const emptyPublications = await publications;
  expect(emptyPublications.ok()).toBeTruthy();
  expect(await emptyPublications.json()).toEqual({ rows: [], nextCursor: null });
  await expect(
    page.getByText("Publish a public Telegram post to collect its discussion here.", {
      exact: true,
    }),
  ).toBeVisible();
  for (const target of [
    open,
    resolved,
    discovery,
    page.getByRole("button", { name: "Refresh list", exact: true }),
  ]) {
    const box = await target.boundingBox();
    expect(box).not.toBeNull();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect(box?.width).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: "/tmp/pubrick-inbox-empty-mobile.png", fullPage: true });

  await page.getByRole("main").getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(/\/en\/settings\/telegram$/);
  await expect(page.getByText("No Telegram account connected", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Phone number", { exact: true })).toBeVisible();
  // This fixture has no operator account or app credentials. Never request a login code.
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Back to brand", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/en/brands/${brand.id}$`));
  await page.context().clearCookies();
  const unauthenticated = await page.request.get(`/api/brands/${brand.id}/inbox?filter=open`);
  expect(unauthenticated.status()).toBe(401);
});
