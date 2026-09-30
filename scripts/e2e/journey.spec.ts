import { expect, test } from "@playwright/test";

test("account, workspace, manual draft, persisted edits and tenant switching", async ({
  page,
  context,
}) => {
  await page.goto("/en/signup");
  await page.getByLabel("Name", { exact: true }).fill("Browser editor");
  await page.getByLabel("Email", { exact: true }).fill("editor@browser.example");
  await page.getByLabel("Password", { exact: true }).fill("Disposable-browser-password-123!");
  await page.getByRole("button", { name: "Sign up", exact: true }).click();
  await page.getByLabel("Organization name").fill("Browser workspace");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page).toHaveURL(/\/en\/brands$/);
  await page.getByLabel("New brand name").fill("Browser brand");
  await page.getByRole("button", { name: "Create brand", exact: true }).click();
  await page.getByRole("link", { name: "Add a channel", exact: true }).click();
  await page.getByLabel("Platform", { exact: true }).selectOption("t_j");
  await page.getByLabel("Channel name", { exact: true }).fill("Browser manual");
  await page.getByRole("button", { name: "Add channel", exact: true }).click();
  await expect(page.getByText("Browser manual", { exact: false }).first()).toBeVisible();
  await page.goto("/en/content/new");
  await page.getByLabel("Brand", { exact: true }).selectOption({ label: "Browser brand" });
  await page.getByRole("checkbox", { name: /Browser manual/ }).check();
  await page.getByLabel("Title", { exact: true }).fill("Browser release journey");
  await page
    .getByLabel("Body", { exact: true })
    .fill("A human-written draft for the disposable browser suite.");
  await page.getByRole("button", { name: "Create post", exact: true }).click();
  await expect(page).toHaveURL(/\/en\/content\/[a-f0-9-]+$/);
  const draftPath = new URL(page.url()).pathname;
  await page
    .getByLabel("Body", { exact: true })
    .fill("Reviewed and edited by a human. Never published by this suite.");
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" && response.url().includes("/api/content/"),
  );
  await page.getByRole("button", { name: "Save body", exact: true }).click();
  expect((await saved).ok()).toBeTruthy();
  await page.reload();
  await expect(page.getByLabel("Body", { exact: true })).toHaveValue(
    "Reviewed and edited by a human. Never published by this suite.",
  );
  await expect(
    page.getByRole("button", { name: "Approve and prepare", exact: true }),
  ).toBeVisible();
  expect(
    (await context.cookies()).some(
      (cookie) => cookie.httpOnly && cookie.name.includes("session_token"),
    ),
  ).toBeTruthy();
  // Exercise the real same-origin auth rewrite and cookie update. This is fixture
  // setup for a second tenant, not an intercepted API or fabricated session.
  const result = await page.evaluate(async () => {
    const post = async (path: string, body: object) => {
      const response = await fetch(`/api/auth/organization/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`Organization ${path} failed: ${response.status}`);
      return response.json();
    };
    const session = await (await fetch("/api/auth/get-session")).json();
    const original = session.session.activeOrganizationId;
    const other = await post("create", { name: "Second workspace", slug: "browser-second" });
    await post("set-active", { organizationId: other.id });
    return { original, other: other.id };
  });
  expect(result.original).not.toBe(result.other);
  await page.goto("/ru/brands");
  await expect(page.getByLabel("Название нового бренда")).toBeVisible();
  await expect(page.getByRole("link", { name: "Browser brand", exact: true })).toHaveCount(0);
  await page.evaluate(async (organizationId) => {
    const response = await fetch("/api/auth/organization/set-active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organizationId }),
    });
    if (!response.ok) throw new Error("Switch back failed");
  }, result.original);
  await page.goto(draftPath);
  await expect(page.getByLabel("Body", { exact: true })).toHaveValue(
    "Reviewed and edited by a human. Never published by this suite.",
  );
});
