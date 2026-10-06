import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { submitSignup } from "./signup";

test.skip(
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: owned browser runner is outside Turbo tasks.
  process.env.PUBRICK_E2E_HOSTED === "1",
  "Uses the owned self-hosted browser stack",
);
test.use({ actionTimeout: 10_000 });

test("native Meta configuration and mobile explicit Page selection recover without replay", async ({
  page,
}) => {
  await page.goto("/en/signup");
  await page.getByLabel("Name", { exact: true }).fill("Meta studio editor");
  await page.getByLabel("Email", { exact: true }).fill("meta@browser.example");
  await page.getByLabel("Password", { exact: true }).fill("Disposable-Meta-password-123!");
  await submitSignup(page);
  await page.getByLabel("Organization name").fill("Meta workspace");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page).toHaveURL(/\/en\/brands$/);
  await page.getByLabel("New brand name").fill("Meta studio");
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/brands",
  );
  await page.getByRole("button", { name: "Create brand", exact: true }).click();
  const brand: { id: string } = await (await created).json();
  await page.goto(`/en/brands/${brand.id}`);
  for (const platform of ["threads", "instagram_native", "facebook_page"]) {
    await page.getByLabel("Platform", { exact: true }).selectOption(platform);
    await expect(
      page.getByText(
        "This server does not have this provider’s application configured. Ask the server administrator to configure it.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect account", exact: true })).toBeDisabled();
    await expect(page.getByLabel("Access token", { exact: true })).toHaveCount(0);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "/tmp/pubrick-meta-unconfigured-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  // The manual Instagram choice remains an ordinary real server-created channel.
  await page.getByLabel("Platform", { exact: true }).selectOption("instagram");
  await page.getByLabel("Channel name", { exact: true }).fill("Manual studio Instagram");
  const added = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/channels",
  );
  await page.getByRole("button", { name: "Add channel", exact: true }).click();
  const manual = await added;
  expect(manual.status()).toBe(201);
  expect(await manual.json()).toMatchObject({ platform: "instagram", connection: null });

  // An unconfigured application really refuses a callback; no external provider is contacted.
  await page.goto("/en/connections/meta/threads?code=synthetic-code&state=first&state=second");
  await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
  expect(new URL(page.url()).search).toBe("");
  await expect(page.getByRole("link", { name: "Back to brands", exact: true })).toBeVisible();

  // Only the discovery response is synthetic. Selection reaches the actual API
  // and refuses the unconfigured application before intent lookup. Ownership
  // and one-use state are exercised separately by real API transport fixtures.
  const requestId = randomUUID();
  let completionCalls = 0;
  await page.route("**/api/channels/meta/complete", async (route) => {
    completionCalls++;
    expect(route.request().postDataJSON()).toEqual({
      provider: "facebook_page",
      parameters: "code=fixture-code&state=fixture-state",
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "choose_page",
        requestId,
        brandId: brand.id,
        locale: "en",
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        pages: [
          { id: "111", name: "Studio" },
          { id: "222", name: "Studio" },
        ],
      }),
    });
  });
  let selections = 0;
  page.on("request", (req) => {
    if (new URL(req.url()).pathname === "/api/channels/meta/select-page") selections++;
  });
  await page.goto("/en/connections/meta/facebook_page?code=fixture-code&state=fixture-state");
  await expect(
    page.getByRole("heading", { name: "Choose a Facebook Page", exact: true }),
  ).toBeVisible();
  const radios = page.getByRole("radio");
  await expect(radios).toHaveCount(2);
  for (const radio of await radios.all()) await expect(radio).not.toBeChecked();
  const connect = page.getByRole("button", { name: "Connect selected Page", exact: true });
  await expect(connect).toBeDisabled();
  await page.getByRole("radio", { name: "Studio Page ID: 222", exact: true }).check();
  await expect(connect).toBeEnabled();
  await page.screenshot({ path: "/tmp/pubrick-meta-page-selection-mobile.png", fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const label of await page.locator("label").all())
    expect((await label.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  const result = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/channels/meta/select-page",
  );
  await connect.click();
  const refused = await result;
  expect(refused.status()).toBe(503);
  expect(await refused.json()).toMatchObject({ code: "meta_unavailable" });
  expect(refused.request().postDataJSON()).toEqual({ requestId, pageId: "222" });
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "This server does not have this provider’s application configured.",
  );
  await expect(connect).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Back to brands", exact: true })).toBeVisible();
  expect(selections).toBe(1);
  expect(completionCalls).toBe(1);
  expect(new URL(page.url()).search).toBe("");

  // Seed only an owned, synthetic interrupted preparation. Recovery, user
  // authority and history then run through the compiled API and actual browser.
  // This does not establish real provider authorization or publication.
  const database = process.env.DATABASE_URL;
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: owned runner identity, never a user database.
  const disposable = process.env.PUBRICK_E2E_DISPOSABLE;
  if (
    !database ||
    new URL(database).hostname !== "127.0.0.1" ||
    new URL(database).pathname !== "/pubrick_browser" ||
    !disposable?.startsWith("pubrick-browser-")
  )
    throw new Error("Owned disposable Meta browser stack required");
  interface FixturePool {
    query<T>(query: string, values?: unknown[]): Promise<{ rows: T[] }>;
    end(): Promise<void>;
  }
  const dbRequire = createRequire(resolve("packages/db/package.json"));
  const { Pool } = dbRequire("pg") as { Pool: new (options: object) => FixturePool };
  const pool = new Pool({
    connectionString: database,
    max: 1,
    connectionTimeoutMillis: 2000,
    statement_timeout: 5000,
  });
  try {
    const tenants = await pool.query<{ org_id: string }>(
      "select org_id from brands where id = $1",
      [brand.id],
    );
    expect(tenants.rows).toHaveLength(1);
    const orgId = tenants.rows[0]?.org_id;
    if (!orgId) throw new Error("Accepted Meta brand tenant missing");
    const channelId = randomUUID();
    const itemId = randomUUID();
    const adaptationId = randomUUID();
    const stageId = randomUUID();
    const body = "Human reviewed content for an interrupted Meta preparation.";
    const frozenInput = { version: 1, platform: "threads", text: body };
    const inputHash = createHash("sha256").update(JSON.stringify(frozenInput)).digest("hex");
    await pool.query("begin");
    try {
      await pool.query(
        `insert into channels (id,org_id,brand_id,platform,name,connection_target,connection_application_id,connection_generation)
        values ($1,$2,$3,'threads','Studio Threads','threads:123','123456',1)`,
        [channelId, orgId, brand.id],
      );
      await pool.query(
        `insert into content_items (id,org_id,brand_id,title,body,status)
        values ($1,$2,$3,'Interrupted Meta post',$4,'failed')`,
        [itemId, orgId, brand.id, body],
      );
      await pool.query(
        `insert into adaptations (id,org_id,content_item_id,channel_id,status,attempt_count,last_error,failure_reason)
        values ($1,$2,$3,$4,'failed',1,'Preparation response was lost','platform_rejected')`,
        [adaptationId, orgId, itemId, channelId],
      );
      await pool.query(
        `insert into meta_publication_stages
        (id,org_id,brand_id,content_item_id,adaptation_id,channel_id,platform,attempt,input_hash,frozen_input,target,credential_generation,
          phase,container_id,failure_reason,preparation_deadline)
        values ($1,$2,$3,$4,$5,$6,'threads',1,$7,$8::jsonb,'threads:123',1,'preparation_unknown','456','preparation_receipt_lost',clock_timestamp()+interval '1 hour')`,
        [
          stageId,
          orgId,
          brand.id,
          itemId,
          adaptationId,
          channelId,
          inputHash,
          JSON.stringify(frozenInput),
        ],
      );
      await pool.query("commit");
    } catch (error) {
      await pool.query("rollback");
      throw error;
    }
    const snapshot = async () => {
      const item = await pool.query(
        "select status,body,updated_at from content_items where id=$1 and org_id=$2",
        [itemId, orgId],
      );
      const adaptation = await pool.query(
        "select status,attempt_count,body,updated_at from adaptations where id=$1 and org_id=$2",
        [adaptationId, orgId],
      );
      const jobs = await pool.query(
        "select id,state,data from pgboss.job where data->>'orgId'=$1 and data->>'adaptationId'=$2 order by id",
        [orgId, adaptationId],
      );
      const receipts = await pool.query(
        "select id,status,external_id from publications where org_id=$1 and adaptation_id=$2 order by id",
        [orgId, adaptationId],
      );
      return {
        item: item.rows,
        adaptation: adaptation.rows,
        jobs: jobs.rows,
        receipts: receipts.rows,
      };
    };
    await page.goto(`/en/content/${itemId}`);
    await expect(
      page.getByRole("heading", { name: "Meta preparation", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Preparation ID: 456", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: /456/ })).toHaveCount(0);
    const before = await snapshot();
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Discard preparation?", exact: true });
    await expect(dialog.getByRole("button", { name: "Discard", exact: true })).toBeDisabled();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await snapshot()).toEqual(before);
    await page.getByRole("button", { name: "Discard", exact: true }).click();
    await dialog.getByRole("checkbox").check();
    expect((await dialog.locator("label").boundingBox())?.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: "/tmp/pubrick-meta-preparation-mobile.png", fullPage: true });
    const discarded = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname ===
          `/api/content/${itemId}/meta-preparations/${stageId}/discard`,
    );
    await dialog.getByRole("button", { name: "Discard", exact: true }).click();
    const discardedResult = await discarded;
    expect(discardedResult.status()).toBe(200);
    expect(discardedResult.request().postDataJSON()).toEqual({
      expectedAttempt: 1,
      expectedInputHash: inputHash,
      acknowledgeNonpublicPreparation: true,
    });
    await expect(page.getByText("Preparation cancelled", { exact: true })).toBeVisible();
    await expect(page.getByText("Preparation ID: 456", { exact: true })).toBeVisible();
    expect(await snapshot()).toEqual(before);
    expect(
      (
        await pool.query(
          "select phase,container_id,input_hash,final_publication_id from meta_publication_stages where id=$1 and org_id=$2",
          [stageId, orgId],
        )
      ).rows,
    ).toEqual([
      {
        phase: "cancelled",
        container_id: "456",
        input_hash: inputHash,
        final_publication_id: null,
      },
    ]);
    await page.reload();
    await expect(page.getByText("Preparation cancelled", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Discard", exact: true })).toHaveCount(0);
  } finally {
    await pool.end();
  }
});
