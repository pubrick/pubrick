import { expect, type Page } from "@playwright/test";

/** The compiled app keeps its real 3-per-10-second signup protection enabled. */
export async function submitSignup(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const submitted = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/auth/sign-up/email",
    );
    await page.getByRole("button", { name: "Sign up", exact: true }).click();
    const response = await submitted;
    if (response.status() === 429 && attempt === 0) {
      await expect(page.getByRole("alert").filter({ hasText: "Too many requests" })).toBeVisible();
      // Better Auth's response has no Retry-After. Wait one complete known
      // limiter window once; never disable the guard or retry an unknown result.
      await page.waitForTimeout(11_000);
      continue;
    }
    expect(response.ok(), `Disposable signup returned HTTP ${response.status()}`).toBe(true);
    return;
  }
}
