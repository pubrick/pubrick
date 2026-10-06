import { expect, test } from "@playwright/test";

test.skip(
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: the hosted runner owns a separate journey.
  process.env.PUBRICK_E2E_HOSTED === "1",
  "Composer and calendar run on the disposable self-hosted stack.",
);
test.use({ timezoneId: "UTC", actionTimeout: 10_000 });

type Snapshot = {
  adaptations: {
    id: string;
    channelId: string;
    body: string | null;
    scheduledAt: string | null;
    attemptCount: number;
    status: string;
  }[];
};

test("retained channel edits, confirmed atomic swap and stale mobile calendar recovery", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/en/signup");
  await page.getByLabel("Name", { exact: true }).fill("Calendar editor");
  await page.getByLabel("Email", { exact: true }).fill("calendar@browser.example");
  await page.getByLabel("Password", { exact: true }).fill("Disposable-calendar-password-123!");
  await page.getByRole("button", { name: "Sign up", exact: true }).click();
  await page.getByLabel("Organization name").fill("Calendar workspace");
  await page.getByRole("button", { name: "Create organization", exact: true }).click();
  await expect(page).toHaveURL(/\/en\/brands$/);
  await page.getByLabel("New brand name").fill("Calendar brand");
  const createdBrand = page.waitForResponse(
    (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/brands",
  );
  await page.getByRole("button", { name: "Create brand", exact: true }).click();
  const brand: { id: string } = await (await createdBrand).json();
  const channels: { id: string; name: string }[] = [];
  for (const name of ["Calendar one", "Calendar two"]) {
    const response = await page.request.post("/api/channels", {
      data: {
        brandId: brand.id,
        platform: "telegram",
        name,
        credentials: {
          botToken: "74001:pubrick_disposable_channel_only",
          chatId: "-1001234567890",
        },
      },
    });
    expect(response.ok()).toBeTruthy();
    channels.push(await response.json());
  }
  const firstChannel = channels[0];
  const secondChannel = channels[1];
  if (!firstChannel || !secondChannel) throw new Error("Missing browser fixture channels");

  const read = async (id: string): Promise<Snapshot> => {
    const response = await page.request.get(`/api/content/${id}`);
    expect(response.ok()).toBeTruthy();
    return response.json();
  };
  const create = async (title: string, names: string[]) => {
    await page.goto("/en/content/new");
    await page.getByLabel("Brand", { exact: true }).selectOption({ label: "Calendar brand" });
    for (const name of names) await page.getByRole("checkbox", { name: new RegExp(name) }).check();
    await page.getByLabel("Title", { exact: true }).fill(title);
    await page.getByLabel("Body", { exact: true }).fill(`Human content prepared for ${title}.`);
    await page.getByRole("button", { name: "Create post", exact: true }).click();
    await expect(page).toHaveURL(/\/en\/content\/[a-f0-9-]+$/);
    const id = new URL(page.url()).pathname.split("/").at(-1);
    if (!id) throw new Error("Missing created content ID");
    return id;
  };
  const schedule = async (at: string) => {
    await page.getByLabel("Or schedule for", { exact: true }).fill(at.slice(0, 16));
    const approved = page.waitForResponse(
      (r) => r.request().method() === "POST" && /\/api\/content\/[^/]+\/approve$/.test(r.url()),
    );
    await page.getByRole("button", { name: "Approve with schedule", exact: true }).click();
    expect((await approved).ok()).toBeTruthy();
  };
  const firstId = await create("First calendar post", ["Calendar one", "Calendar two"]);
  const firstTab = page.getByRole("tab", { name: /Telegram · Calendar one/ });
  const secondTab = page.getByRole("tab", { name: /Telegram · Calendar two/ });
  await firstTab.click();
  await page
    .getByLabel("Override for Telegram · Calendar one", { exact: true })
    .fill("First channel's retained text.");
  await secondTab.click();
  await page
    .getByLabel("Override for Telegram · Calendar two", { exact: true })
    .fill("Second channel's retained text.");
  await secondTab.press("ArrowLeft");
  await expect(firstTab).toBeFocused();
  await expect(
    page.getByLabel("Override for Telegram · Calendar one", { exact: true }),
  ).toHaveValue("First channel's retained text.");
  await expect(page.getByRole("button", { name: "Publish now", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Publish now", exact: true })).toBeEnabled();
  const saved = await read(firstId);
  expect(saved.adaptations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        channelId: firstChannel.id,
        body: "First channel's retained text.",
      }),
      expect.objectContaining({
        channelId: secondChannel.id,
        body: "Second channel's retained text.",
      }),
    ]),
  );
  const tomorrow = new Date(Date.now() + 86_400_000);
  tomorrow.setUTCHours(12, 0, 0, 0);
  const firstTime = tomorrow.toISOString();
  const secondTime = new Date(tomorrow.getTime() + 3_600_000).toISOString();
  await schedule(firstTime);
  const secondId = await create("Second calendar post", ["Calendar one"]);
  await schedule(secondTime);
  const beforeFirst = await read(firstId);
  const beforeSecond = await read(secondId);
  const firstDelivery = beforeFirst.adaptations.find((a) => a.channelId === firstChannel.id);
  const sibling = beforeFirst.adaptations.find((a) => a.channelId === secondChannel.id);
  const secondDelivery = beforeSecond.adaptations[0];
  if (!firstDelivery || !sibling || !secondDelivery)
    throw new Error("Missing scheduled deliveries");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/en/brands/${brand.id}/publications`);
  await page.getByRole("tab", { name: "Scheduled", exact: true }).click();
  await page.getByRole("tab", { name: "Calendar", exact: true }).click();
  await page.getByLabel("Date", { exact: true }).fill(firstTime.slice(0, 10));
  await page.getByRole("tab", { name: "Day", exact: true }).click();
  const selectFirst = page.getByRole("checkbox", {
    name: "Select First calendar post for Calendar one",
    exact: true,
  });
  const selectSecond = page.getByRole("checkbox", {
    name: "Select Second calendar post for Calendar one",
    exact: true,
  });
  await expect(selectFirst).toBeEnabled();
  await selectFirst.focus();
  await selectFirst.press("Space");
  await selectSecond.check();
  await page.getByRole("button", { name: "Swap", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm new times" });
  await expect(dialog).toContainText(firstTime);
  await expect(dialog).toContainText(secondTime);
  // Inspect before pressing Confirm: preview alone must not mutate delivery times.
  expect((await read(firstId)).adaptations).toEqual(beforeFirst.adaptations);
  expect((await read(secondId)).adaptations).toEqual(beforeSecond.adaptations);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: "/tmp/pubrick-calendar-confirm-mobile.png", fullPage: true });
  const moved = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.url().endsWith(`/api/brands/${brand.id}/publications/reschedule`),
  );
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  expect((await moved).ok()).toBeTruthy();
  await expect(page.getByText("Deliveries moved.", { exact: true })).toBeVisible();
  expect((await read(firstId)).adaptations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: firstDelivery.id,
        scheduledAt: secondTime,
        attemptCount: firstDelivery.attemptCount + 1,
      }),
      sibling,
    ]),
  );
  expect((await read(secondId)).adaptations).toEqual([
    expect.objectContaining({
      id: secondDelivery.id,
      scheduledAt: firstTime,
      attemptCount: secondDelivery.attemptCount + 1,
    }),
  ]);
  await page.screenshot({ path: "/tmp/pubrick-calendar-mobile.png", fullPage: true });

  // Another editor moves one row after this screen's read; the entire stale swap is refused.
  const remoteTime = new Date(tomorrow.getTime() + 7_200_000).toISOString();
  const remote = await page.request.post(
    `/api/content/${firstId}/adaptations/${firstDelivery.id}/reschedule`,
    {
      data: { expectedScheduledAt: secondTime, scheduledAt: remoteTime },
    },
  );
  expect(remote.ok()).toBeTruthy();
  const remoteFirst = await read(firstId);
  const remoteSecond = await read(secondId);
  await selectFirst.check();
  await selectSecond.check();
  await page.getByRole("button", { name: "Swap", exact: true }).click();
  const stale = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" &&
      r.url().endsWith(`/api/brands/${brand.id}/publications/reschedule`),
  );
  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
  expect((await stale).status()).toBe(409);
  await expect(page.getByRole("alert").filter({ hasText: "Reload" })).toBeVisible();
  await expect(selectFirst).toBeDisabled();
  expect((await read(firstId)).adaptations).toEqual(remoteFirst.adaptations);
  expect((await read(secondId)).adaptations).toEqual(remoteSecond.adaptations);
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(selectFirst).toBeEnabled();
  await page.getByRole("link", { name: "First calendar post", exact: true }).first().click();
  await expect(page).toHaveURL(
    new RegExp(`/en/content/${firstId}#adaptation-${firstDelivery.id}$`),
  );
  await expect(page.getByRole("tab", { name: /Telegram · Calendar one/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    page.getByLabel("Override for Telegram · Calendar one", { exact: true }),
  ).toHaveValue("First channel's retained text.");
});
