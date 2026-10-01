import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { editorialPlanEnableSchema } from "../../packages/shared/src/dto/editorial-plans.js";

// Observation only: all user mutations happen through the actual browser UI.
const dbRequire = createRequire(resolve("packages/db/package.json"));
interface ObservationPool {
  query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
}
const { Pool } = dbRequire("pg") as { Pool: new (options: object) => ObservationPool };
const databaseUrl = process.env.DATABASE_URL;
// biome-ignore lint/suspicious/noUndeclaredEnvVars: runner-owned unique journey marker.
const marker = process.env.PUBRICK_E2E_JOURNEY_MARKER;
// biome-ignore lint/suspicious/noUndeclaredEnvVars: runner-owned bounded receipt file.
const receiptsPath = process.env.PUBRICK_E2E_RECEIPTS;
if (!databaseUrl || new URL(databaseUrl).hostname !== "127.0.0.1" || !marker || !receiptsPath)
  throw new Error("Disposable recurring runner required");
// biome-ignore lint/suspicious/noUndeclaredEnvVars: runner-owned channel context evidence.
const channelContext = process.env.PUBRICK_E2E_CHANNEL_CONTEXT;
if (!channelContext) throw new Error("Runner channel context required");
const syntheticKey = "AIzaSy-Pubrick-disposable-weekly-browser-only";
const model = "gemini-3.8-flash";
type Occurrence = {
  id: string;
  state: string;
  run_id: string | null;
  slot_id: string | null;
  local_date: string;
  reason: string | null;
  [field: string]: unknown;
};
type Run = {
  id: string;
  status: string;
  content_item_id: string | null;
  steps: Record<string, { status: string }>;
  text_selection: { provider: string; modelId: string };
  error: string | null;
};

test("weekly plan generates one metered draft, human edit, pause/resume and permanent skip", async ({
  page,
}) => {
  const journeyStartedAt = Date.now();
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
    await page.getByLabel("Name", { exact: true }).fill("Weekly editor");
    await page.getByLabel("Email", { exact: true }).fill("weekly@browser.example");
    await page.getByLabel("Password", { exact: true }).fill("Disposable-weekly-password-123!");
    await page.getByRole("button", { name: "Sign up", exact: true }).click();
    await page.getByLabel("Organization name").fill("Weekly workspace");
    await page.getByRole("button", { name: "Create organization", exact: true }).click();
    await expect(page).toHaveURL(/\/en\/brands$/);
    await page.getByLabel("New brand name").fill("Weekly brand");
    const brandResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/brands",
    );
    await page.getByRole("button", { name: "Create brand", exact: true }).click();
    const brand: { id: string; orgId: string } = await (await brandResponse).json();
    await page.getByRole("link", { name: "Add a channel", exact: true }).click();
    await page.getByLabel("Platform", { exact: true }).selectOption("t_j");
    await page.getByLabel("Channel name", { exact: true }).fill("Weekly manual");
    const channelResponse = page.waitForResponse(
      (response) => response.request().method() === "POST" && response.url().includes("/channels"),
    );
    await page.getByRole("button", { name: "Add channel", exact: true }).click();
    const channel: { id: string } = await (await channelResponse).json();
    await writeFile(
      channelContext,
      JSON.stringify({ id: channel.id, name: "Weekly manual", platform: "t_j", marker }),
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
    // No provider probe: every model call must belong to the scheduled run.
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/en/brands/${brand.id}/calendar`);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const form = page.getByRole("form", { name: "Add weekly plan" });
    await form.getByLabel("Plan name", { exact: true }).fill("Weekly acceptance");
    await form
      .getByLabel("Recurring brief", { exact: true })
      .fill(`${marker}: write a useful weekly social post.`);
    await form.getByLabel("Timezone (IANA)").fill("UTC");
    await form.getByRole("checkbox", { name: "Weekly plan channel: Weekly manual" }).check();
    const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    let due = new Date(Math.ceil((Date.now() + 120_000) / 60_000) * 60_000);
    const schedule = async () => {
      for (let i = 0; i < weekdays.length; i++)
        await form
          .getByRole("checkbox", { name: weekdays[i], exact: true })
          .setChecked(i + 1 === (due.getUTCDay() || 7));
      await form
        .getByLabel("Generation time", { exact: true })
        .fill(due.toISOString().slice(11, 16));
      await form.getByLabel("Start date", { exact: true }).fill(due.toISOString().slice(0, 10));
      await form
        .getByLabel("End date", { exact: true })
        .fill(new Date(due.getTime() + 8 * 86_400_000).toISOString().slice(0, 10));
      const previewResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().includes("/editorial-plans/preview"),
      );
      await form.getByRole("button", { name: "Preview", exact: true }).click();
      const preview = (await (await previewResponse).json()) as {
        occurrences: { scheduledAt: string | null }[];
      };
      expect(
        preview.occurrences.some((occurrence) => occurrence.scheduledAt === due.toISOString()),
      ).toBe(true);
    };
    await schedule();
    await page.screenshot({
      path: test.info().outputPath("weekly-plan-mobile-preview.png"),
      fullPage: true,
    });
    const created = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/calendar/editorial-plans",
    );
    await form.getByRole("button", { name: "Save", exact: true }).click();
    const plan: { id: string } = await (await created).json();
    const card = page.getByRole("region", { name: "Weekly acceptance", exact: true });
    await expect(card.getByText("Disabled", { exact: true })).toBeVisible();
    if (due.getTime() - Date.now() < 60_000) {
      await card.getByRole("button", { name: "Edit", exact: true }).click();
      due = new Date(Math.ceil((Date.now() + 120_000) / 60_000) * 60_000);
      // The same fields are now owned by the edit form; page-level labels are unique.
      await page
        .getByLabel("Generation time", { exact: true })
        .fill(due.toISOString().slice(11, 16));
      await page.getByLabel("Start date", { exact: true }).fill(due.toISOString().slice(0, 10));
      await page
        .getByLabel("End date", { exact: true })
        .fill(new Date(due.getTime() + 8 * 86_400_000).toISOString().slice(0, 10));
      for (let i = 0; i < weekdays.length; i++)
        await page
          .getByRole("form", { name: "Edit weekly plan" })
          .getByRole("checkbox", { name: weekdays[i], exact: true })
          .setChecked(i + 1 === (due.getUTCDay() || 7));
      await page
        .getByRole("form", { name: "Edit weekly plan" })
        .getByRole("button", { name: "Preview", exact: true })
        .click();
      await page
        .getByRole("form", { name: "Edit weekly plan" })
        .getByRole("button", { name: "Save", exact: true })
        .click();
      await page
        .getByRole("dialog", { name: "Save changes?" })
        .getByRole("button", { name: "Save", exact: true })
        .click();
    }
    expect(due.getTime() - Date.now()).toBeGreaterThanOrEqual(60_000);
    const enable = async () => {
      await card.getByRole("button", { name: "Enable", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Enable paid generation?" });
      const consent = dialog.getByRole("checkbox", {
        name: "I authorize paid generation with my saved provider credentials for this plan.",
      });
      await consent.focus();
      await page.keyboard.press("Space");
      await expect(consent).toBeChecked();
      const enableButton = dialog.getByRole("button", { name: "Enable", exact: true });
      await expect(enableButton).toBeEnabled();
      await enableButton.focus();
      await page.keyboard.press("Tab");
      await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(enableButton).toBeFocused();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({ path: test.info().outputPath("weekly-plan-mobile-consent.png") });
      const admitted = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().includes(`/editorial-plans/${plan.id}/enable`),
      );
      await page.keyboard.press("Enter");
      const admission = await admitted;
      expect(admission.ok()).toBe(true);
      const payload = admission.request().postDataJSON();
      expect(payload).toMatchObject({
        allowPaidGeneration: true,
        consentVersion: "byok-paid-generation-v1",
      });
      expect(editorialPlanEnableSchema.parse(payload)).toEqual(payload);
      await expect(card.getByText("Enabled", { exact: true })).toBeVisible();
    };
    await enable();
    const generationDeadline = due.getTime() + 120_000;
    await expect
      .poll(
        async () => {
          await latch();
          const runs = await rows<Run>(
            "SELECT id, status, content_item_id, steps, text_selection, error FROM pipeline_runs WHERE brand_id=$1",
            [brand.id],
          );
          expect(runs.length).toBeLessThanOrEqual(1);
          const candidate = runs[0];
          if (candidate?.status === "failed" || candidate?.status === "cancelled")
            throw new Error(`Scheduled run failed: ${candidate.error}`);
          return candidate?.status;
        },
        { timeout: Math.max(1, generationDeadline - Date.now()), intervals: [500, 1000] },
      )
      .toBe("succeeded");
    const generated = (
      await rows<Run>(
        "SELECT id, status, content_item_id, steps, text_selection, error FROM pipeline_runs WHERE brand_id=$1",
        [brand.id],
      )
    )[0];
    if (!generated?.content_item_id) throw new Error("Generated draft missing");
    expect(generated.text_selection).toMatchObject({ provider: "google", modelId: model });
    expect(Object.keys(generated.steps).sort()).toEqual(
      [`adapter:${channel.id}`, "editor", "factcheck", "researcher", "writer"].sort(),
    );
    expect(Object.values(generated.steps).every((step) => step.status === "succeeded")).toBe(true);
    const ledger = await rows<{ status: string; step: string; provider: string; model_id: string }>(
      "SELECT status, step, provider, model_id FROM usage_ledger WHERE run_id=$1",
      [generated.id],
    );
    expect(ledger).toHaveLength(5);
    expect(
      ledger.every(
        (call) => call.status === "ok" && call.provider === "google" && call.model_id === model,
      ),
    ).toBe(true);
    expect(ledger.map((call) => call.step).sort()).toEqual(Object.keys(generated.steps).sort());
    const adaptations = await rows<{ channel_id: string; body: string }>(
      "SELECT channel_id, body FROM adaptations WHERE content_item_id=$1",
      [generated.content_item_id],
    );
    expect(adaptations).toHaveLength(1);
    expect(adaptations[0]).toMatchObject({
      channel_id: channel.id,
      body: expect.stringContaining(marker),
    });
    const calls = await latch();
    expect(calls).toHaveLength(5);
    expect(calls.map((call) => call.role).sort()).toEqual([
      `adapter:${channel.id}`,
      "editor",
      "factcheck",
      "researcher",
      "writer",
    ]);
    expect(calls.every((call) => call.marker === marker)).toBe(true);
    const occurrences = await rows<Occurrence>(
      "SELECT * FROM editorial_plan_occurrences WHERE plan_id=$1 ORDER BY local_date",
      [plan.id],
    );
    const admittedOccurrences = occurrences.filter(
      (occurrence) => occurrence.state === "dispatched",
    );
    expect(admittedOccurrences).toHaveLength(1);
    const dispatched = admittedOccurrences[0];
    if (!dispatched) throw new Error("Dispatched occurrence missing");
    expect(dispatched.run_id).toBe(generated.id);
    const futureIdentity = occurrences.find((occurrence) => occurrence.state === "planned");
    if (!futureIdentity) throw new Error("Future identity missing before pause");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/en/content/${generated.content_item_id}`);
    await expect(page.getByLabel("Body", { exact: true })).toHaveValue(new RegExp(marker));
    const postActionDeadline = Date.now() + 180_000;
    test.setTimeout(Date.now() - journeyStartedAt + 180_000);
    const editedBody = `${marker}. Reviewed and edited by a human; never published.`;
    await page.getByLabel("Body", { exact: true }).fill(editedBody);
    const savedBody = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        response.url().includes(`/api/content/${generated?.content_item_id}`),
    );
    await page.getByRole("button", { name: "Save body", exact: true }).click();
    expect((await savedBody).ok()).toBe(true);
    await page.reload();
    await expect(page.getByLabel("Body", { exact: true })).toHaveValue(editedBody);
    await page.goto(`/en/brands/${brand.id}/calendar`);
    await card.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(card.getByText("Disabled", { exact: true })).toBeVisible();
    await enable();
    // Enable acknowledges admission before its real queued materializer runs.
    // Wait for the same retained identity to be replanned; never write fixture rows.
    await expect
      .poll(
        async () => {
          const occurrence = (
            await rows<Occurrence>("SELECT * FROM editorial_plan_occurrences WHERE id=$1", [
              futureIdentity.id,
            ])
          )[0];
          return occurrence?.state === "planned" && Boolean(occurrence.slot_id);
        },
        { timeout: Math.min(90_000, postActionDeadline - Date.now()), intervals: [500, 1000] },
      )
      .toBe(true);
    const future = (
      await rows<Occurrence>("SELECT * FROM editorial_plan_occurrences WHERE id=$1", [
        futureIdentity.id,
      ])
    )[0];
    if (!future?.slot_id) throw new Error("Future occurrence missing after resume");
    // The visible summary must catch up after worker completion without reload.
    await expect(
      card
        .getByRole("listitem")
        .filter({ hasText: future.local_date })
        .getByText("Planned", { exact: true }),
    ).toBeVisible({ timeout: Math.min(15_000, postActionDeadline - Date.now()) });
    // Observe UI selection of the future date, then the actual Skip confirmation.
    await page.goto(
      `/en/brands/${brand.id}/calendar?at=${encodeURIComponent(String(future.scheduled_at instanceof Date ? future.scheduled_at.toISOString() : future.scheduled_at))}&slot=${future.slot_id}`,
    );
    await page
      .locator(`#calendar-slot-${future.slot_id}`)
      .getByRole("button", { name: "Skip", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Skip this occurrence?" })
      .getByRole("button", { name: "Skip", exact: true })
      .click();
    await expect(page.locator(`#calendar-slot-${future.slot_id}`)).toHaveCount(0);
    await expect(
      card.getByText("Skipped manually; this date will not regenerate.", { exact: false }),
    ).toBeVisible();
    const afterSkip = new Date();
    await expect
      .poll(
        async () =>
          (
            await rows<{ count: string }>(
              "SELECT count(*) FROM pgboss.job WHERE name='editorial-plan-scan' AND state='completed' AND completed_on > $1",
              [afterSkip],
            )
          )[0]?.count ?? "0",
        { timeout: 90_000, intervals: [1000] },
      )
      .not.toBe("0");
    const skipped = (
      await rows<Occurrence>("SELECT * FROM editorial_plan_occurrences WHERE id=$1", [future.id])
    )[0];
    expect(skipped).toMatchObject({ state: "skipped", reason: "manual_skip", run_id: null });
    expect(
      (
        await rows<Occurrence>("SELECT * FROM editorial_plan_occurrences WHERE id=$1", [
          dispatched?.id,
        ])
      )[0],
    ).toEqual(dispatched);
    await card.getByRole("button", { name: "Remove", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Remove weekly plan?" })
      .getByRole("button", { name: "Remove", exact: true })
      .click();
    await expect(card).toHaveCount(0);
    expect(
      (
        await rows<{ removed_at: Date; enabled: boolean }>(
          "SELECT removed_at, enabled FROM editorial_plans WHERE id=$1",
          [plan.id],
        )
      )[0],
    ).toMatchObject({ enabled: false, removed_at: expect.any(Date) });
    expect(
      (
        await rows<Occurrence>("SELECT * FROM editorial_plan_occurrences WHERE id=$1", [
          dispatched?.id,
        ])
      )[0],
    ).toEqual(dispatched);
    expect(await rows("SELECT id FROM publications")).toHaveLength(0);
    expect(
      await rows("SELECT id FROM pgboss.job WHERE name IN ('publish','publish-dlq')"),
    ).toHaveLength(0);
    expect(await rows("SELECT id FROM pipeline_runs WHERE brand_id=$1", [brand.id])).toHaveLength(
      1,
    );
    expect(await latch()).toHaveLength(5);
    expect(Date.now()).toBeLessThan(postActionDeadline);
  } finally {
    await pool.end();
  }
});
