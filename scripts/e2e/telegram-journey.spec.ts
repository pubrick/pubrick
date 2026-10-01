import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";

interface ObservationPool {
  query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
  end(): Promise<void>;
}
const dbRequire = createRequire(resolve("packages/db/package.json"));
const { Pool } = dbRequire("pg") as { Pool: new (options: object) => ObservationPool };
const database = process.env.DATABASE_URL;
// biome-ignore lint/suspicious/noUndeclaredEnvVars: owned disposable journey marker.
const marker = process.env.PUBRICK_E2E_JOURNEY_MARKER;
// biome-ignore lint/suspicious/noUndeclaredEnvVars: owned loopback synthetic provider control plane.
const fixtureOrigin = process.env.PUBRICK_E2E_TELEGRAM_FIXTURE;
if (
  !database ||
  new URL(database).hostname !== "127.0.0.1" ||
  !/^telegram-browser-[a-f0-9-]{36}$/.test(marker ?? "") ||
  fixtureOrigin !== "http://127.0.0.1:31303"
)
  throw new Error("Owned Telegram browser runner required");
const token = "74001:pubrick_disposable_telegram_only";
type Message = {
  messageId: number;
  chatId: number;
  body: {
    text: string;
    reply_markup: {
      inline_keyboard: Array<Array<{ text: string; url?: string; callback_data?: string }>>;
    };
  };
};
type State = { messages: Message[]; unexpected: string[]; installed: boolean };
type Draft = { itemId: string; title: string; adaptationId: string; runId: string };
async function control<T>(page: Page, path: string, data: object = {}): Promise<T> {
  const response = await page.request.post(`${fixtureOrigin}/fixture/${path}`, {
    headers: { "x-pubrick-disposable-marker": marker as string },
    data,
  });
  expect(response.ok(), `Owned fixture ${path}`).toBe(true);
  return response.json() as Promise<T>;
}

test("HTTPS Telegram settings, two-phase binding, worker notification, private reject and harmless stale/replayed decisions", async ({
  page,
}) => {
  const pool = new Pool({
    connectionString: database,
    max: 1,
    connectionTimeoutMillis: 2000,
    statement_timeout: 5000,
  });
  const rows = async <T>(sql: string, values: unknown[] = []) =>
    (await pool.query<T>(sql, values)).rows;
  const state = async () => {
    const value = await control<State>(page, "state");
    expect(value.unexpected).toEqual([]);
    return value;
  };
  const notification = async (itemId: string, operation: "ir" | "cr") => {
    let message: Message | undefined;
    await expect
      .poll(
        async () => {
          message = (await state()).messages.find((entry) => {
            const buttons = entry.body.reply_markup.inline_keyboard.flat();
            return (
              buttons.some((button) => button.url?.includes(itemId)) &&
              buttons.some((button) => button.callback_data?.startsWith(`${operation}:`))
            );
          });
          return Boolean(message);
        },
        { timeout: 90_000, intervals: [200, 500, 1000] },
      )
      .toBe(true);
    if (!message) throw new Error("Expected physical synthetic Telegram message");
    return message;
  };
  const item = async (itemId: string) =>
    (
      await rows<{ status: string; first_opened_at: Date | null; body: string }>(
        "SELECT status, first_opened_at, body FROM content_items WHERE id=$1",
        [itemId],
      )
    )[0];
  try {
    await page.goto("/en/signup");
    await page.getByLabel("Name", { exact: true }).fill("Telegram browser editor");
    await page.getByLabel("Email", { exact: true }).fill("telegram@browser.example");
    await page.getByLabel("Password", { exact: true }).fill("Disposable-telegram-password-123!");
    const signupResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/auth/sign-up/email",
    );
    await page.getByRole("button", { name: "Sign up", exact: true }).click();
    const signup: { user: { id: string } } = await (await signupResponse).json();
    expect(signup.user.id).toBeTruthy();
    await page.getByLabel("Organization name").fill("Telegram browser workspace");
    await page.getByRole("button", { name: "Create organization", exact: true }).click();
    await expect(page).toHaveURL(/\/en\/brands$/);
    await page.getByLabel("New brand name").fill("Telegram browser brand");
    const brandResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/brands",
    );
    await page.getByRole("button", { name: "Create brand", exact: true }).click();
    const createdBrand: { id: string } = await (await brandResponse).json();
    const [scopedBrand] = await rows<{ org_id: string }>("SELECT org_id FROM brands WHERE id=$1", [
      createdBrand.id,
    ]);
    if (!scopedBrand) throw new Error("Accepted brand is missing from the owned database");
    const brand = { id: createdBrand.id, orgId: scopedBrand.org_id };
    await page.getByRole("link", { name: "Add a channel", exact: true }).click();
    await page.getByLabel("Platform", { exact: true }).selectOption("t_j");
    await page.getByLabel("Channel name", { exact: true }).fill("Telegram browser manual channel");
    const channelResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/channels",
    );
    await page.getByRole("button", { name: "Add channel", exact: true }).click();
    const channel: { id: string } = await (await channelResponse).json();
    await page.goto("/en/settings/notifications");
    await page.getByLabel("Bot token", { exact: true }).fill(token);
    await page.getByLabel("Destination chat ID", { exact: true }).fill("-10042");
    await page.getByRole("checkbox", { name: "Enable notifications", exact: true }).check();
    await page.getByRole("checkbox", { name: "Draft ready for review", exact: true }).check();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Notification settings saved.", { exact: true })).toBeVisible();
    const bot = page
      .getByRole("heading", { name: "Workspace Telegram bot", exact: true })
      .locator("..");
    await bot.getByRole("button", { name: "Enable account connections", exact: true }).click();
    await expect.poll(async () => (await state()).installed).toBe(true);
    await expect(
      bot.getByText("The bot is active for account connections and private draft confirmations.", {
        exact: true,
      }),
    ).toBeVisible();
    const account = page
      .getByRole("heading", { name: "Your Telegram account", exact: true })
      .locator("..");
    await account.getByRole("button", { name: "Connect Telegram", exact: true }).click();
    const link = await account
      .getByRole("link", { name: "Open Telegram", exact: true })
      .getAttribute("href");
    if (!link || new URL(link).hostname !== "t.me")
      throw new Error("Expected opaque verified bot deep link");
    const started = await control<{ status: number }>(page, "start", {
      code: new URL(link).searchParams.get("start"),
    });
    expect(started.status).toBe(200);
    expect(
      await rows("SELECT id FROM telegram_bindings WHERE org_id=$1 AND state='linked'", [
        brand.orgId,
      ]),
    ).toEqual([]);
    await account.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(account.getByText("<Synthetic Human>", { exact: true })).toBeVisible();
    await expect(account.getByText("Telegram user ID: 74002", { exact: true })).toBeVisible();
    await account.getByRole("button", { name: "Confirm account", exact: true }).click();
    await expect(
      account.getByText("Your Telegram account is connected.", { exact: true }),
    ).toBeVisible();

    const seed = (scenario: string) =>
      control<Draft>(page, "draft", {
        orgId: brand.orgId,
        brandId: brand.id,
        channelId: channel.id,
        scenario,
      });
    const draft = await seed("reject");
    const initial = await notification(draft.itemId, "ir");
    expect(initial.chatId).toBe(-10042);
    const buttons = initial.body.reply_markup.inline_keyboard.flat();
    expect(buttons.filter((button) => button.text === "Reject")).toHaveLength(1);
    expect(buttons.find((button) => button.text === "Reject")).toMatchObject({
      callback_data: expect.stringMatching(/^ir:[A-Za-z0-9_-]{43}$/),
    });
    expect(buttons.filter((button) => button.url)).toHaveLength(3);
    for (const button of buttons.filter((entry) => entry.url))
      expect(new URL(button.url as string).origin).toBe("https://127.0.0.1:31302");
    expect(await item(draft.itemId)).toMatchObject({ status: "draft", first_opened_at: null });
    const group = await control<{ status: number }>(page, "callback", {
      messageId: initial.messageId,
      operation: "ir",
    });
    expect(group.status).toBe(200);
    const privateMessage = await notification(draft.itemId, "cr");
    expect(privateMessage.chatId).toBe(74002);
    expect(privateMessage.body.text).toContain(draft.title);
    expect(privateMessage.body.text).toContain("Nothing will be published.");
    expect(await item(draft.itemId)).toMatchObject({ status: "draft", first_opened_at: null });
    const confirmed = await control<{ status: number; updateId: number }>(page, "callback", {
      messageId: privateMessage.messageId,
      operation: "cr",
    });
    expect(confirmed.status).toBe(200);
    await expect.poll(async () => (await item(draft.itemId))?.status).toBe("rejected");
    expect((await item(draft.itemId))?.first_opened_at).toBeNull();
    const evidence = await rows<{
      capability_id: string;
      actor_user_id: string;
      snapshot_version: string;
    }>(
      "SELECT capability_id, actor_user_id, snapshot_version FROM telegram_decision_audit WHERE org_id=$1 AND content_item_id=$2",
      [brand.orgId, draft.itemId],
    );
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.actor_user_id).toBe(signup.user.id);
    expect(evidence[0]?.snapshot_version).toBe("client-review-v1");
    expect(
      await rows("SELECT state FROM telegram_actor_confirmations WHERE id=$1", [
        evidence[0]?.capability_id,
      ]),
    ).toEqual([{ state: "consumed" }]);
    expect(await control(page, "replay", { updateId: confirmed.updateId })).toMatchObject({
      status: 200,
    });
    expect(
      await rows("SELECT id FROM telegram_decision_audit WHERE content_item_id=$1", [draft.itemId]),
    ).toHaveLength(1);

    const stale = await seed("stale");
    const staleInitial = await notification(stale.itemId, "ir");
    expect(
      await control(page, "callback", { messageId: staleInitial.messageId, operation: "ir" }),
    ).toMatchObject({ status: 200 });
    const stalePrivate = await notification(stale.itemId, "cr");
    await page.goto(`/en/content/${stale.itemId}`);
    const edited = "A later human edit must survive the old Telegram confirmation.";
    await page.getByLabel("Body", { exact: true }).fill(edited);
    const save = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        new URL(response.url()).pathname === `/api/content/${stale.itemId}`,
    );
    await page.getByRole("button", { name: "Save body", exact: true }).click();
    expect((await save).ok()).toBe(true);
    const staleResult = await control<{ status: number; updateId: number }>(page, "callback", {
      messageId: stalePrivate.messageId,
      operation: "cr",
    });
    expect(staleResult.status).toBe(200);
    expect(await item(stale.itemId)).toMatchObject({ status: "draft", body: edited });
    expect(await control(page, "replay", { updateId: staleResult.updateId })).toMatchObject({
      status: 200,
    });
    expect(
      await rows("SELECT id FROM telegram_decision_audit WHERE content_item_id=$1", [stale.itemId]),
    ).toEqual([]);

    const unlink = await seed("unlink");
    const unlinkInitial = await notification(unlink.itemId, "ir");
    expect(
      await control(page, "callback", { messageId: unlinkInitial.messageId, operation: "ir" }),
    ).toMatchObject({ status: 200 });
    const unlinkPrivate = await notification(unlink.itemId, "cr");
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/en/settings/notifications");
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const mobileAccount = page
      .getByRole("heading", { name: "Your Telegram account", exact: true })
      .locator("..");
    await mobileAccount.getByRole("button", { name: "Unlink", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Unlink your Telegram account?", exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Unlink", exact: true }).click();
    await expect(
      mobileAccount.getByText("Your Telegram account is not connected.", { exact: true }),
    ).toBeVisible();
    expect(
      await control(page, "callback", { messageId: unlinkPrivate.messageId, operation: "cr" }),
    ).toMatchObject({ status: 200 });
    expect(await item(unlink.itemId)).toMatchObject({ status: "draft", first_opened_at: null });
    expect(
      await rows("SELECT id FROM telegram_bindings WHERE org_id=$1 AND state='linked'", [
        brand.orgId,
      ]),
    ).toEqual([]);
    expect(
      await rows(
        "SELECT id FROM telegram_actor_confirmations WHERE org_id=$1 AND state='pending'",
        [brand.orgId],
      ),
    ).toEqual([]);
    expect(
      await rows("SELECT id FROM telegram_decision_audit WHERE org_id=$1", [brand.orgId]),
    ).toHaveLength(1);
    expect(await rows("SELECT id FROM usage_ledger")).toEqual([]);
    expect(await rows("SELECT id FROM publications")).toEqual([]);
    expect((await state()).messages).toHaveLength(6);
    expect(
      await rows<{ status: string }>("SELECT status FROM notification_events WHERE org_id=$1", [
        brand.orgId,
      ]),
    ).toEqual([{ status: "sent" }, { status: "sent" }, { status: "sent" }]);
  } finally {
    await pool.end();
  }
});
