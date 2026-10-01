import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
  contentReuseCreateSchema,
  contentReuseResultSchema,
  contentReuseSourcePreviewSchema,
} from "../../packages/shared/src/dto/content-reuse.js";

// Observation only; all content, settings and generation writes use actual UI.
const dbRequire = createRequire(resolve("packages/db/package.json"));
interface ObservationPool {
  query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
}
const { Pool } = dbRequire("pg") as { Pool: new (options: object) => ObservationPool };
const databaseUrl = process.env.DATABASE_URL;
// biome-ignore lint/suspicious/noUndeclaredEnvVars: disposable runner-only identity.
const marker = process.env.PUBRICK_E2E_JOURNEY_MARKER;
// biome-ignore lint/suspicious/noUndeclaredEnvVars: runner-only durable transport latch.
const receiptsPath = process.env.PUBRICK_E2E_RECEIPTS;
// biome-ignore lint/suspicious/noUndeclaredEnvVars: UI-created channel observation for preload.
const channelContext = process.env.PUBRICK_E2E_CHANNEL_CONTEXT;
if (
  !databaseUrl ||
  new URL(databaseUrl).hostname !== "127.0.0.1" ||
  !marker ||
  !receiptsPath ||
  !channelContext
)
  throw new Error("Disposable evergreen runner required");
const syntheticKey = "AIzaSy-Pubrick-disposable-evergreen-browser-only";
const model = "gemini-3.8-flash";
type Run = {
  id: string;
  status: string;
  content_item_id: string | null;
  steps: Record<string, { status: string }>;
  input: { kind: string; material: string; channelIds: string[] };
  error: string | null;
};

test("saved master, canceled consent, one paid reuse and independent human-edited draft", async ({
  page,
}) => {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 2000,
    statement_timeout: 5000,
  });
  const rows = async <T>(sql: string, values: unknown[] = []) =>
    (await pool.query<T>(sql, values)).rows;
  const latch = async () => {
    const receipts = (await readFile(receiptsPath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind: string; role: string; marker: string });
    expect(receipts.some((receipt) => receipt.kind === "unexpected")).toBe(false);
    return receipts;
  };
  try {
    await page.goto("/en/signup");
    await page.getByLabel("Name", { exact: true }).fill("Evergreen editor");
    await page.getByLabel("Email", { exact: true }).fill("evergreen@browser.example");
    await page.getByLabel("Password", { exact: true }).fill("Disposable-evergreen-password-123!");
    await page.getByRole("button", { name: "Sign up", exact: true }).click();
    await page.getByLabel("Organization name").fill("Evergreen workspace");
    await page.getByRole("button", { name: "Create organization", exact: true }).click();
    await expect(page).toHaveURL(/\/en\/brands$/);
    await page.getByLabel("New brand name").fill("Evergreen brand");
    const brandResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/brands",
    );
    await page.getByRole("button", { name: "Create brand", exact: true }).click();
    const brand: { id: string } = await (await brandResponse).json();
    // Public brand responses omit tenant identity. Resolve the accepted brand
    // in this disposable database so NULL cannot make audit assertions vacuous.
    const tenants = await rows<{ org_id: string }>("SELECT org_id FROM brands WHERE id=$1", [
      brand.id,
    ]);
    expect(tenants).toHaveLength(1);
    const orgId = tenants[0]?.org_id;
    if (!orgId) throw new Error("Accepted brand tenant missing");
    await page.getByRole("link", { name: "Add a channel", exact: true }).click();
    await page.getByLabel("Platform", { exact: true }).selectOption("t_j");
    await page.getByLabel("Channel name", { exact: true }).fill("Evergreen manual");
    const channelResponse = page.waitForResponse(
      (response) => response.request().method() === "POST" && response.url().includes("/channels"),
    );
    await page.getByRole("button", { name: "Add channel", exact: true }).click();
    const channel: { id: string } = await (await channelResponse).json();
    await writeFile(
      channelContext,
      JSON.stringify({ id: channel.id, name: "Evergreen manual", platform: "t_j", marker }),
      { mode: 0o600 },
    );
    await page.goto("/en/settings");
    await page.getByLabel("Provider", { exact: true }).selectOption("google");
    await page.getByLabel("API key", { exact: true }).fill(syntheticKey);
    await page.getByRole("button", { name: "Save key", exact: true }).click();
    await expect(
      page.getByText("Key saved. Test the connection to confirm it works.", { exact: true }),
    ).toBeVisible();
    const textSettings = page.getByRole("region", { name: "Text generation" });
    await textSettings.getByLabel("Text provider", { exact: true }).selectOption("google");
    await textSettings.getByText("Model options", { exact: true }).click();
    await textSettings.getByLabel("Default model", { exact: true }).fill(model);
    await textSettings.getByRole("button", { name: "Save", exact: true }).click();
    await expect(textSettings.getByText("Text settings saved.", { exact: true })).toBeVisible();
    // No provider probe: every model call must belong to the reused run.
    await page.goto("/en/content/new");
    await page.getByLabel("Brand", { exact: true }).selectOption(brand.id);
    await page.getByRole("checkbox", { name: /Evergreen manual/ }).check();
    await page.getByLabel("Title", { exact: true }).fill("Saved evergreen master");
    await page.getByLabel("Body", { exact: true }).fill(`${marker}. An initial human master.`);
    await page.getByRole("button", { name: "Create post", exact: true }).click();
    await expect(page).toHaveURL(/\/en\/content\/[a-f0-9-]+$/);
    const sourceId = new URL(page.url()).pathname.split("/").at(-1);
    if (!sourceId) throw new Error("Source identity missing");
    const sourceMaterial = `${marker}. Saved human master with a useful point. The derived text needs its own review.`;
    await page.getByLabel("Body", { exact: true }).fill(sourceMaterial);
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        new URL(response.url()).pathname === `/api/content/${sourceId}`,
    );
    await page.getByRole("button", { name: "Save body", exact: true }).click();
    expect((await saved).ok()).toBe(true);
    await page.reload();
    await expect(page.getByLabel("Body", { exact: true })).toHaveValue(sourceMaterial);
    const source = (
      await rows<{ body_revision: number; first_opened_at: Date; status: string }>(
        "SELECT body_revision, first_opened_at, status FROM content_items WHERE id=$1",
        [sourceId],
      )
    )[0];
    if (!source) throw new Error("Saved source missing");
    expect(source).toMatchObject({ first_opened_at: expect.any(Date), status: "draft" });
    const previewResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        new URL(response.url()).pathname === `/api/content/${sourceId}/reuse-source`,
    );
    await page.getByRole("button", { name: "Reuse as source", exact: true }).click();
    await expect(page).toHaveURL(
      (url) => url.pathname === "/en/content/new" && url.search === `?source=${sourceId}`,
    );
    const preview = contentReuseSourcePreviewSchema.parse(await (await previewResponse).json());
    expect(preview).toMatchObject({
      id: sourceId,
      brandId: brand.id,
      material: sourceMaterial,
      bodyRevision: source.body_revision,
    });
    await expect(page.getByTestId("reuse-source-preview")).toHaveText(sourceMaterial);
    await page.getByRole("checkbox", { name: /Evergreen manual/ }).check();
    await page.getByLabel("Title", { exact: true }).fill("Independent reused draft");
    await page
      .getByLabel("Brief", { exact: true })
      .fill(`${marker}: use the saved master as context, write for a new reader.`);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Generate one new draft?" });
    await expect(dialog.getByRole("button", { name: "Generate", exact: true })).toBeDisabled();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(
      await rows("SELECT id FROM content_reuse_operations WHERE org_id=$1", [orgId]),
    ).toHaveLength(0);
    expect(await rows("SELECT id FROM pipeline_runs WHERE brand_id=$1", [brand.id])).toHaveLength(
      0,
    );
    expect(await latch()).toHaveLength(0);
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    const consent = dialog.getByRole("checkbox", {
      name: "I agree to start this paid generation using my provider key.",
    });
    await consent.focus();
    await page.keyboard.press("Space");
    await expect(consent).toBeChecked();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: test.info().outputPath("evergreen-mobile-consent.png") });
    const admittedResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === `/api/content/${sourceId}/reuse`,
    );
    await dialog.getByRole("button", { name: "Generate", exact: true }).click();
    const admission = await admittedResponse;
    expect(admission.ok()).toBe(true);
    const request = admission.request();
    const body = request.postDataJSON();
    expect(contentReuseCreateSchema.parse(body)).toEqual(body);
    expect(body).toMatchObject({
      expectedSourceRevision: preview.bodyRevision,
      expectedSourceDigest: preview.digest,
      title: "Independent reused draft",
      channelIds: [channel.id],
      allowPaidGeneration: true,
      consentVersion: "byok-paid-generation-v1",
    });
    const result = contentReuseResultSchema.parse(await admission.json());
    await expect(page).toHaveURL(new RegExp(`/en/content/runs/${result.id}$`));
    await expect
      .poll(
        async () => {
          await latch();
          const runs = await rows<Run>(
            "SELECT id, status, content_item_id, steps, input, error FROM pipeline_runs WHERE brand_id=$1",
            [brand.id],
          );
          expect(runs).toHaveLength(1);
          return runs[0]?.status;
        },
        { timeout: 120_000, intervals: [500, 1000] },
      )
      .toBe("succeeded");
    const run = (
      await rows<Run>(
        "SELECT id, status, content_item_id, steps, input, error FROM pipeline_runs WHERE id=$1",
        [result.id],
      )
    )[0];
    if (!run?.content_item_id) throw new Error("Independent output missing");
    expect(run.id).toBe(result.id);
    expect(run.input).toMatchObject({
      kind: "source",
      material: sourceMaterial,
      channelIds: [channel.id],
    });
    const operations = await rows<{
      result_run_id: string;
      root_source_id: string;
      root_source_revision: number;
      idempotency_key: string;
    }>(
      "SELECT result_run_id, root_source_id, root_source_revision, idempotency_key FROM content_reuse_operations WHERE org_id=$1",
      [orgId],
    );
    expect(operations).toHaveLength(1);
    expect(operations[0]).toEqual({
      result_run_id: result.id,
      root_source_id: sourceId,
      root_source_revision: preview.bodyRevision,
      idempotency_key: request.headers()["idempotency-key"],
    });
    const jobs = await rows<{ data: object }>(
      "SELECT data FROM pgboss.job WHERE name='generate'",
      [],
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data).toEqual({ runId: result.id, orgId });
    expect(
      await rows(
        "SELECT derived_run_id FROM run_source_lineage WHERE derived_run_id=$1 AND source_content_id=$2",
        [result.id, sourceId],
      ),
    ).toHaveLength(1);
    const output = (
      await rows(
        "SELECT status, origin, first_opened_at, cover_media_id, video_media_id, requires_imported_review FROM content_items WHERE id=$1",
        [run.content_item_id],
      )
    )[0];
    expect(output).toEqual({
      status: "draft",
      origin: "ai",
      first_opened_at: null,
      cover_media_id: null,
      video_media_id: null,
      requires_imported_review: false,
    });
    expect(
      await rows(
        "SELECT origin, scope FROM content_versions WHERE content_item_id=$1 AND adaptation_id IS NULL",
        [run.content_item_id],
      ),
    ).toEqual([{ origin: "ai", scope: "full" }]);
    const adaptations = await rows(
      "SELECT status, origin, scheduled_at, attempt_count FROM adaptations WHERE content_item_id=$1",
      [run.content_item_id],
    );
    expect(adaptations).toEqual([
      { status: "pending", origin: "ai", scheduled_at: null, attempt_count: 0 },
    ]);
    expect(
      await rows("SELECT id FROM content_image_slots WHERE content_item_id=$1", [
        run.content_item_id,
      ]),
    ).toHaveLength(0);
    const attribution = page.getByTestId("saved-source-attribution");
    await expect(
      attribution.getByRole("link", { name: "Saved evergreen master", exact: true }),
    ).toHaveAttribute("href", `/en/content/${sourceId}`);
    const calls = await latch();
    expect(calls).toHaveLength(5);
    expect(calls.map((call) => call.role).sort()).toEqual([
      `adapter:${channel.id}`,
      "editor",
      "factcheck",
      "researcher",
      "writer",
    ]);
    expect(Object.keys(run.steps).sort()).toEqual(calls.map((call) => call.role).sort());
    expect(Object.values(run.steps).every((step) => step.status === "succeeded")).toBe(true);
    expect(
      await rows("SELECT id FROM usage_ledger WHERE run_id=$1 AND status='ok'", [result.id]),
    ).toHaveLength(5);
    await expect(page.getByText("Reused from saved content", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "Draft ready", exact: true }).click();
    await expect(page.getByLabel("Body", { exact: true })).toHaveValue(new RegExp(marker));
    await expect(page.getByText("Reused from saved content", { exact: true })).toBeVisible();
    const editedBody = `${marker}. The derived draft was separately reviewed and edited by a human.`;
    await page.getByLabel("Body", { exact: true }).fill(editedBody);
    const edited = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        new URL(response.url()).pathname === `/api/content/${run.content_item_id}`,
    );
    await page.getByRole("button", { name: "Save body", exact: true }).click();
    expect((await edited).ok()).toBe(true);
    await page.reload();
    await expect(page.getByLabel("Body", { exact: true })).toHaveValue(editedBody);
    expect(
      (await rows<{ body: string }>("SELECT body FROM content_items WHERE id=$1", [sourceId]))[0]
        ?.body,
    ).toBe(sourceMaterial);
    expect(await rows("SELECT id FROM publications")).toHaveLength(0);
    expect(
      await rows("SELECT id FROM pgboss.job WHERE name IN ('publish','publish-dlq')"),
    ).toHaveLength(0);
    expect(await rows("SELECT id FROM calendar_slots")).toHaveLength(0);
    expect(await rows("SELECT id FROM media_assets")).toHaveLength(0);
    expect(
      await rows("SELECT id FROM content_reuse_operations WHERE org_id=$1", [orgId]),
    ).toHaveLength(1);
    expect(await latch()).toHaveLength(5);
  } finally {
    await pool.end();
  }
});
