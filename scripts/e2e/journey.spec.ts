import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import type { ManualPlatformId } from "../../packages/shared/src/dto/channels.js";

test.skip(
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: the separate hosted runner selects its own acceptance journey.
  process.env.PUBRICK_E2E_HOSTED === "1",
  "Self-hosted journey runs on its own disposable stack.",
);

const manualPlatform = "t_j" satisfies ManualPlatformId;
test.use({ actionTimeout: 10_000 });

test("account, manual approval, verified channel, worker publication and UI tenant switching", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  await expect(page).toHaveURL(/\/en$/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Installation guide" })).toHaveAttribute(
    "href",
    "https://github.com/pubrick/pubrick/blob/main/docs/self-hosting.md",
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: "/tmp/pubrick-landing-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: "/tmp/pubrick-landing-desktop.png", fullPage: true });
  await page.getByRole("link", { name: "Sign up", exact: true }).click();
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
  await page.getByLabel("Platform", { exact: true }).selectOption(manualPlatform);
  const brandPath = new URL(page.url()).pathname;
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
  await page.getByRole("button", { name: "Approve and prepare", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Ready for manual publishing", exact: true }),
  ).toBeDisabled();
  const manual = await page.request.get(`/api/content/${draftPath.split("/").at(-1)}`);
  expect(manual.ok()).toBeTruthy();
  expect((await manual.json()).adaptations).toEqual([
    expect.objectContaining({ status: "manual_ready" }),
  ]);
  // Only the provider boundary is synthetic. UI, API, encrypted credentials,
  // PostgreSQL queue, compiled worker and persisted receipts all remain real.
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: owned loopback provider from run.mjs.
  const providerOrigin = process.env.PUBRICK_E2E_NATIVE_ORIGIN;
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: synthetic fixture-control credential.
  const providerSecret = process.env.PUBRICK_E2E_NATIVE_SECRET;
  if (!providerOrigin || new URL(providerOrigin).hostname !== "127.0.0.1" || !providerSecret)
    throw new Error("Owned native channel fixture required");
  const fixtureState = async () => {
    const response = await page.request.get(`${providerOrigin}/fixture/state`, {
      headers: { authorization: `Bearer ${providerSecret}` },
    });
    expect(response.ok()).toBeTruthy();
    return response.json();
  };
  await page.goto(brandPath);
  await page.getByLabel("Platform", { exact: true }).selectOption("telegram");
  await page.getByLabel("Channel name", { exact: true }).fill("Browser native");
  await page.getByLabel("Bot token", { exact: true }).fill("74001:pubrick_disposable_channel_only");
  await page.getByLabel("Chat ID", { exact: true }).fill("-1001234567890");
  const added = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/api/channels"),
  );
  await page.getByRole("button", { name: "Add channel", exact: true }).click();
  const channelResponse = await added;
  expect(channelResponse.ok()).toBeTruthy();
  const channel = await channelResponse.json();
  expect(JSON.stringify(channel)).not.toContain("74001:pubrick_disposable_channel_only");
  await page.reload();
  await expect(page.getByText("Browser native", { exact: false }).first()).toBeVisible();
  const checked = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith(`/api/channels/${channel.id}/test`),
  );
  await page.getByRole("button", { name: "Test connection", exact: true }).click();
  const checkedResponse = await checked;
  expect(checkedResponse.ok()).toBeTruthy();
  expect(await checkedResponse.json()).toEqual({
    ok: true,
    account: "@browser_bot",
    target: "Browser channel",
  });
  await expect(
    page.getByText("OK — connected as @browser_bot, can post to Browser channel", { exact: false }),
  ).toBeVisible();
  await page.goto("/en/content/new");
  await page.getByLabel("Brand", { exact: true }).selectOption({ label: "Browser brand" });
  await page.getByRole("checkbox", { name: /Browser native/ }).check();
  await page.getByLabel("Title", { exact: true }).fill("Browser native publication");
  await page
    .getByLabel("Body", { exact: true })
    .fill("A reviewed post delivered only to the local Telegram fixture.");
  await page.getByRole("button", { name: "Create post", exact: true }).click();
  await expect(page).toHaveURL(/\/en\/content\/[a-f0-9-]+$/);
  const nativePath = new URL(page.url()).pathname;
  expect((await fixtureState()).calls).toEqual(["getMe", "getChat", "getChatMember"]);
  const approved = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/approve"),
  );
  await page.getByRole("button", { name: "Publish now", exact: true }).click();
  const approvedResponse = await approved;
  expect(approvedResponse.ok()).toBeTruthy();
  expect(await approvedResponse.json()).toMatchObject({
    status: "approved",
    adaptations: [
      { channelId: channel.id, status: expect.stringMatching(/^(queued|publishing)$/) },
    ],
  });
  try {
    await expect.poll(async () => (await fixtureState()).pending, { timeout: 10_000 }).toBe(true);
    await expect(page.getByText("Publishing", { exact: true }).first()).toBeVisible({
      timeout: 10_000,
    });
  } finally {
    const released = await page.request.post(`${providerOrigin}/fixture/release`, {
      headers: { authorization: `Bearer ${providerSecret}` },
    });
    expect(released.ok()).toBeTruthy();
  }
  await expect(page.getByText("Published", { exact: true }).first()).toBeVisible({
    timeout: 15_000,
  });
  await page.reload();
  const published = await page.request.get(`/api/content/${nativePath.split("/").at(-1)}`);
  expect(published.ok()).toBeTruthy();
  expect(await published.json()).toMatchObject({
    status: "published",
    adaptations: [
      { channelId: channel.id, status: "published", externalUrl: "https://t.me/c/1234567890/88" },
    ],
  });
  expect(await fixtureState()).toMatchObject({
    calls: ["getMe", "getChat", "getChatMember", "sendMessage"],
    unexpected: [],
    pending: false,
  });
  expect(
    (await context.cookies()).some(
      (cookie) => cookie.httpOnly && cookie.name.includes("session_token"),
    ),
  ).toBeTruthy();
  // Create a second tenant through the real same-origin auth endpoint, then
  // exercise both workspace switches through the Settings UI.
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
    const other = await post("create", {
      name: "Second workspace",
      slug: "browser-second",
      keepCurrentActiveOrganization: true,
    });

    return { original, other: other.id };
  });
  expect(result.original).not.toBe(result.other);
  await page.goto("/en/settings");
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("link", { name: "Export workspace data (download opens in a new tab)", exact: true })
    .click();
  const archive = await downloaded;
  expect(await archive.failure()).toBeNull();
  expect(archive.suggestedFilename()).toBe("pubrick-workspace.tar.gz");
  const archivePath = await archive.path();
  if (!archivePath) throw new Error("Browser did not retain the workspace download");
  const records = gunzipSync(await readFile(archivePath)).toString();
  expect(records).toContain("Reviewed and edited by a human. Never published by this suite.");
  expect(records).toContain('"format":"pubrick-workspace-export"');
  expect(records).toContain('"complete":true');
  expect(records).not.toContain("Disposable-browser-password-123!");
  await page.getByLabel("Workspace", { exact: true }).selectOption(result.other);
  await page.getByRole("button", { name: "Switch", exact: true }).click();
  await expect(page).toHaveURL(/\/en\/brands$/);
  await page.goto("/ru/brands");
  await expect(page.getByLabel("Название нового бренда")).toBeVisible();
  await expect(page.getByRole("link", { name: "Browser brand", exact: true })).toHaveCount(0);
  await page.goto("/en/content");
  await expect(
    page.getByRole("link", { name: "Browser release journey", exact: true }),
  ).toHaveCount(0);
  const hidden = await page.request.get(`/api/content/${nativePath.split("/").at(-1)}`);
  expect(hidden.status()).toBe(404);
  await page.goto("/ru/settings");
  await page.getByLabel("Рабочее пространство", { exact: true }).selectOption(result.original);
  await page.getByRole("button", { name: "Переключить", exact: true }).click();
  await expect(page).toHaveURL(/\/ru\/brands$/);
  await page.goto(draftPath);
  await expect(page.getByLabel("Body", { exact: true })).toHaveValue(
    "Reviewed and edited by a human. Never published by this suite.",
  );
});
