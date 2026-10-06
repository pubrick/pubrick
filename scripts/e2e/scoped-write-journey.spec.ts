import { expect, test } from "@playwright/test";
import {
  publicContentDetailV2Schema,
  publicContentListV2Schema,
  publicDraftCreateResultSchema,
  publicDraftCreateSchema,
} from "../../packages/shared/src/dto/public-write.js";
import { submitSignup } from "./signup";

test.skip(
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: the hosted runner owns a separate acceptance journey.
  process.env.PUBRICK_E2E_HOSTED === "1",
  "Scoped writes run on the disposable self-hosted stack.",
);

test("scoped key issuance, imported draft replay, human editing and revocation", async ({
  page,
  playwright,
  baseURL,
}) => {
  await page.goto("/en/signup");
  await page.getByLabel("Name", { exact: true }).fill("Integration editor");
  await page.getByLabel("Email", { exact: true }).fill("integration@browser.example");
  await page.getByLabel("Password", { exact: true }).fill("Disposable-integration-password-123!");
  await submitSignup(page);
  await page.getByLabel("Organization name").fill("Integration workspace");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page).toHaveURL(/\/en\/brands$/);
  await page.getByLabel("New brand name").fill("Integration brand");
  const brandCreated = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/brands",
  );
  await page.getByRole("button", { name: "Create brand", exact: true }).click();
  const brand: { id: string } = await (await brandCreated).json();
  await page.getByRole("link", { name: "Add a channel", exact: true }).click();
  await page.getByLabel("Platform", { exact: true }).selectOption("t_j");
  await page.getByLabel("Channel name", { exact: true }).fill("Integration manual");
  const channelCreated = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/channels",
  );
  await page.getByRole("button", { name: "Add channel", exact: true }).click();
  const channel: { id: string } = await (await channelCreated).json();

  await page.goto("/en/settings/api-keys");
  const issue = async (name: string, scope: "content:read" | "content:create") => {
    await page.getByRole("button", { name: "Add", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name", { exact: true }).fill(name);
    await dialog.getByLabel("Scope", { exact: true }).selectOption(scope);
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    const secret = dialog.locator("code");
    await expect(secret).toBeVisible();
    const key = await secret.innerText();
    await dialog.getByRole("button", { name: "Done", exact: true }).click();
    return key;
  };
  const readKey = await issue("Integration reader", "content:read");
  const writeKey = await issue("Integration writer", "content:create");

  // A separate request context has no owner's cookies. Otherwise a first-party
  // editorial request could legitimately succeed through the owner's session.
  const publicApi = await playwright.request.newContext({ baseURL });
  try {
    const payload = publicDraftCreateSchema.parse({
      brandId: brand.id,
      channelIds: [channel.id],
      title: "Imported integration draft",
      body: "Text supplied by an external integration. Its authorship is unknown.",
    });
    const writeHeaders = {
      Authorization: `Bearer ${writeKey}`,
      "Idempotency-Key": "browser-import-0001",
    };
    const create = () =>
      publicApi.post("/api/v2/content", { headers: writeHeaders, data: payload });
    const responses = await Promise.all([create(), create()]);
    for (const response of responses) expect(response.ok()).toBe(true);
    const draft = publicDraftCreateResultSchema.parse(await responses[0].json());
    expect(publicDraftCreateResultSchema.parse(await responses[1].json())).toEqual(draft);
    expect(draft).toMatchObject({ origin: "external", requiresReview: true, status: "draft" });

    const readHeaders = { Authorization: `Bearer ${readKey}` };
    const detail = await publicApi.get(`/api/v2/content/${draft.id}`, { headers: readHeaders });
    expect(detail.ok()).toBe(true);
    expect(publicContentDetailV2Schema.parse(await detail.json())).toMatchObject({
      id: draft.id,
      body: payload.body,
      origin: "external",
    });
    const list = await publicApi.get("/api/v2/content", { headers: readHeaders });
    expect(list.ok()).toBe(true);
    expect(publicContentListV2Schema.parse(await list.json()).rows.map((row) => row.id)).toEqual([
      draft.id,
    ]);
    expect(
      (await publicApi.get(`/api/v1/content/${draft.id}`, { headers: readHeaders })).status(),
    ).toBe(404);
    expect(
      (
        await publicApi.post("/api/v2/content", {
          headers: { ...writeHeaders, Authorization: `Bearer ${readKey}` },
          data: payload,
        })
      ).status(),
    ).toBe(401);
    const conflict = await publicApi.post("/api/v2/content", {
      headers: writeHeaders,
      data: { ...payload, body: "Different text with the same replay key." },
    });
    expect(conflict.status()).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "idempotency_conflict" });
    expect(
      (await publicApi.post(`/api/content/${draft.id}/opened`, { headers: writeHeaders })).status(),
    ).toBe(401);

    const opened = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === `/api/content/${draft.id}/opened`,
    );
    await page.goto(`/en/content/${draft.id}`);
    expect((await opened).ok()).toBe(true);
    await expect(page.getByLabel("Body", { exact: true })).toHaveValue(payload.body);
    await expect(page.getByText("Imported", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("status").filter({ hasText: "Refine is available for AI-generated drafts." }),
    ).toBeVisible();
    await page.locator("#review-draft").getByText("Version history", { exact: true }).click();
    await expect(page.getByText(/Imported text/).first()).toBeVisible();
    const edited = "A human edited the imported text in the browser. No publication was requested.";
    await page.getByLabel("Body", { exact: true }).fill(edited);
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        new URL(response.url()).pathname === `/api/content/${draft.id}`,
    );
    await page.getByRole("button", { name: "Save body", exact: true }).click();
    expect((await saved).ok()).toBe(true);
    await page.reload();
    await expect(page.getByLabel("Body", { exact: true })).toHaveValue(edited);
    const replay = await create();
    expect(replay.ok()).toBe(true);
    expect(publicDraftCreateResultSchema.parse(await replay.json())).toEqual(draft);
    const updated = await publicApi.get(`/api/v2/content/${draft.id}`, { headers: readHeaders });
    expect(publicContentDetailV2Schema.parse(await updated.json()).body).toBe(edited);

    await page.goto("/en/settings/api-keys");
    await page
      .getByText("Integration writer", { exact: true })
      .locator("..")
      .locator("..")
      .getByRole("button", { name: "Revoke", exact: true })
      .click();
    await page.getByRole("dialog").getByRole("button", { name: "Revoke", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect((await create()).status()).toBe(401);
  } finally {
    await publicApi.dispose();
  }
});
