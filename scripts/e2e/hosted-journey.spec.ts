import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { expect, type Page, test } from "@playwright/test";

// biome-ignore lint/suspicious/noUndeclaredEnvVars: only the disposable hosted runner sets this flag.
const hosted = process.env.PUBRICK_E2E_HOSTED === "1";
// biome-ignore lint/suspicious/noUndeclaredEnvVars: synthetic fixture control credentials never enter the application.
const controlOrigin = process.env.PUBRICK_E2E_CONTROL_ORIGIN;
// biome-ignore lint/suspicious/noUndeclaredEnvVars: synthetic fixture control credentials never enter the application.
const controlSecret = process.env.PUBRICK_E2E_CONTROL_SECRET;
test.skip(!hosted, "Run node scripts/e2e/hosted.run.mjs with its disposable fixture stack.");
test.use({ actionTimeout: 10_000 });

async function control(page: Page, action: string, orgId: string) {
  if (!controlOrigin || !controlSecret) throw new Error("Hosted fixture control missing");
  const result = await page.request.post(`${controlOrigin}/${action}`, {
    headers: { Authorization: `Bearer ${controlSecret}` },
    data: { orgId },
  });
  expect(result.ok()).toBeTruthy();
}
async function mailLink(page: Page, email: string, part: string) {
  if (!controlOrigin || !controlSecret) throw new Error("Hosted fixture control missing");
  let link: string | undefined;
  let diagnostics: unknown;
  try {
    await expect
      .poll(
        async () => {
          const response = await page.request.get(
            `${controlOrigin}/mail?to=${encodeURIComponent(email)}&part=${encodeURIComponent(part)}`,
            { headers: { Authorization: `Bearer ${controlSecret}` } },
          );
          diagnostics = { status: response.status() };
          expect(response.ok()).toBeTruthy();
          const body = (await response.json()) as {
            links: string[];
            captured: number;
            jobs: unknown[];
            queueDiagnostic: string | null;
          };
          diagnostics = {
            captured: body.captured,
            jobs: body.jobs,
            queueDiagnostic: body.queueDiagnostic,
          };
          link = body.links.at(-1);
          return Boolean(link);
        },
        { timeout: 20_000 },
      )
      .toBe(true);
  } catch {
    throw new Error(`Fixture authentication mail missing: ${JSON.stringify(diagnostics)}`);
  }
  if (!link) throw new Error("Fixture mail link missing");
  return link;
}
async function post(page: Page, path: string, body: object) {
  return page.evaluate(
    async ({ path, body }) => {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
    { path, body },
  );
}
const password = "Disposable-hosted-browser-password-123!";
async function registerAndVerify(page: Page, email: string) {
  await page.goto("/en/signup");
  await page.getByLabel("Name", { exact: true }).fill("Hosted browser editor");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign up", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Check your email", exact: true })).toBeVisible();
  expect(
    (await page.context().cookies()).some((cookie) => cookie.name.includes("session_token")),
  ).toBe(false);
  await page.goto(await mailLink(page, email, "verify-email"));
  await page.goto("/en/login");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await expect(page).toHaveURL(/\/en$/);
  await page.getByRole("link", { name: "Go to brands", exact: true }).click();
  await expect(page).toHaveURL(/\/en\/onboarding/);
}

test("hosted BYOK: verified onboarding, fixture entitlement, human draft, invitation, quotas and expired recovery", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await registerAndVerify(page, "owner@hosted.browser.example");
  await page.getByLabel("Organization name").fill("Hosted browser workspace");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page).toHaveURL(/\/en\/settings$/);
  await expect(page.getByRole("heading", { name: "Subscription", exact: true })).toBeVisible();
  await expect(page.getByText("Not configured", { exact: true })).toBeVisible();
  await expect(page.getByText(/Bring your own AI keys/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Test checkout", exact: true })).toBeDisabled();
  const orgId = await page.evaluate(async () => {
    const session = await (await fetch("/api/auth/get-session")).json();
    return session.session.activeOrganizationId as string;
  });
  expect((await post(page, "/api/brands", { name: "Must not grow unpaid" })).status).toBe(402);
  expect(
    (await post(page, "/api/auth/organization/create", { name: "SDK bypass", slug: "sdk-bypass" }))
      .status,
  ).toBe(403);
  await control(page, "entitlement", orgId);
  await page.reload();
  await expect(page.getByText("Plan browser-fixture · version 1", { exact: true })).toBeVisible();
  await page.goto("/en/brands");
  await page.getByLabel("New brand name").fill("Hosted coffee");
  await page.getByRole("button", { name: "Create brand", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Hosted coffee is ready", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Add a channel", exact: true }).click();
  await expect(page).toHaveURL(/\/en\/brands\/[a-f0-9-]+#channels$/);
  const brandId = new URL(page.url()).pathname.split("/").at(-1);
  if (!brandId || brandId === "brands") throw new Error("Brand setup link did not navigate");
  await page.getByLabel("Platform", { exact: true }).selectOption("t_j");
  await page.getByLabel("Channel name", { exact: true }).fill("Hosted manual channel");
  await page.getByRole("button", { name: "Add channel", exact: true }).click();
  await page.goto("/en/content/new");
  await page.getByLabel("Brand", { exact: true }).selectOption({ label: "Hosted coffee" });
  await page.getByRole("checkbox", { name: /Hosted manual channel/ }).check();
  await page.getByLabel("Title", { exact: true }).fill("Hosted human draft");
  await page
    .getByLabel("Body", { exact: true })
    .fill("Human-authored content without a paid model or publication.");
  await page.getByRole("button", { name: "Create post", exact: true }).click();
  await expect(page).toHaveURL(/\/en\/content\/[a-f0-9-]+$/);
  const draftPath = new URL(page.url()).pathname;
  const edited = "Edited human draft preserved for export after the fixture subscription expires.";
  await page.getByLabel("Body", { exact: true }).fill(edited);
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" && response.url().includes("/api/content/"),
  );
  await page.getByRole("button", { name: "Save body", exact: true }).click();
  expect((await saved).ok()).toBeTruthy();
  await page.reload();
  await expect(page.getByLabel("Body", { exact: true })).toHaveValue(edited);
  await page.goto(`/en/brands/${brandId}/knowledge`);
  await page.getByRole("button", { name: "Add", exact: true }).first().click();
  const note = page.getByRole("dialog");
  await note.getByLabel("Title", { exact: true }).fill("Verified product fact");
  await note
    .getByLabel("Content", { exact: true })
    .fill(
      "Fixture coffee is roasted weekly. This note is manually entered, not indexed by Gemini.",
    );
  await note.getByLabel("Category", { exact: true }).selectOption("product_info");
  await note.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Verified product fact", { exact: true })).toBeVisible();
  await page.goto("/en/settings");
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  const invite = page.getByRole("dialog");
  await invite.getByLabel("Email", { exact: true }).fill("editor@hosted.browser.example");
  await invite.getByLabel("Workspace role", { exact: true }).selectOption("admin");
  await invite.getByRole("button", { name: "Invite", exact: true }).click();
  const invitationLink = await mailLink(page, "editor@hosted.browser.example", "onboarding");
  const second = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const invited = await second.newPage();
    await registerAndVerify(invited, "editor@hosted.browser.example");
    await invited.goto(invitationLink);
    await invited.getByRole("button", { name: "Join", exact: true }).click();
    await expect(invited).toHaveURL(/\/en\/brands$/);
    await invited.goto(draftPath);
    await expect(invited.getByLabel("Body", { exact: true })).toHaveValue(edited);
    await page.goto("/en/settings");
    const seats = await post(page, "/api/hosted-admission/invite", {
      orgId,
      email: "third@hosted.browser.example",
      role: "admin",
      locale: "en",
    });
    expect(seats.status).toBe(409);
    expect(seats.body).toMatchObject({ code: "resource_limit", resource: "seats" });
    await control(page, "expire", orgId);
    await page.reload();
    await expect(page.getByText("Expired", { exact: true })).toBeVisible();
    const refused = await post(page, "/api/brands", { name: "Expired growth" });
    expect(refused.status).toBe(402);
    expect(refused.body).toMatchObject({ code: "subscription_required" });
    await page.goto(draftPath);
    await expect(page.getByLabel("Body", { exact: true })).toHaveValue(edited);
    await page.goto("/en/settings");
    const downloaded = page.waitForEvent("download");
    await page
      .getByRole("link", {
        name: "Export workspace data (download opens in a new tab)",
        exact: true,
      })
      .click();
    const archive = await downloaded;
    expect(await archive.failure()).toBeNull();
    const archivePath = await archive.path();
    if (!archivePath) throw new Error("Fixture export missing");
    const records = gunzipSync(await readFile(archivePath)).toString();
    expect(records).toContain(edited);
    expect(records).toContain("Verified product fact");
    expect(records).toContain('"complete":true');
    expect(records).not.toContain(password);
    expect((await post(page, "/api/hosted-admission/delete", { orgId })).status).toBe(200);
    const gone = await page.request.get(`/api/content/${draftPath.split("/").at(-1)}`);
    expect(gone.ok()).toBe(false);
  } finally {
    await second.close();
  }
});
