import { linkedinAuthorizationStartSchema, refusalBody } from "@pubrick/shared";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authClient } from "@/lib/auth-client";
import { openLinkedInAuthorization } from "@/lib/linkedin";
import { credentialFieldLabel } from "@/lib/platform";
import { signedInSession } from "@/test/auth-client.stub";
import { renderAsync } from "@/test/render";
import en from "../../../../../messages/en.json";
import ru from "../../../../../messages/ru.json";
import Page from "./page";

vi.mock("@/lib/linkedin", () => ({ openLinkedInAuthorization: vi.fn() }));
const brandId = "b669ae6d-4bc8-4650-9f42-588798682198";
const body = (status: number, value: unknown) => new Response(JSON.stringify(value), { status });
beforeEach(() => {
  signedInSession();
  vi.mocked(authClient.useActiveOrganization).mockReturnValue({
    data: { id: "test-org", members: [{ userId: "test-user", role: "admin" }] },
    isPending: false,
  } as never);
  vi.stubGlobal("fetch", vi.fn());
  vi.mocked(openLinkedInAuthorization).mockReset();
});
function install(
  configuration: () => Response = () => body(200, { available: true }),
  authorize: (init?: RequestInit) => Response = () =>
    body(200, {
      authorizationUrl: "https://www.linkedin.com/oauth/v2/authorization?state=fixture",
    }),
) {
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes("/api/channels/linkedin/configuration")) return configuration();
    if (url.endsWith("/api/channels/linkedin/authorize")) return authorize(init);
    if (url.includes("/api/channels?brandId=")) return body(200, []);
    if (url.endsWith(`/api/brands/${brandId}`)) return body(200, { id: brandId, name: "Writing" });
    return body(200, {});
  });
}
describe("brand LinkedIn personal connection entry", () => {
  it("shows expired authorization without a contradictory healthy cached badge", async () => {
    install();
    const original = vi.mocked(fetch).getMockImplementation();
    if (!original) throw new Error("fixture fetch missing");
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      String(input).includes("/api/channels?brandId=")
        ? body(200, [
            {
              id: "250b3665-6484-4c6f-bf08-6f8f9a96e544",
              name: "Writer",
              platform: "linkedin",
              connection: {
                state: "expired",
                generation: 1,
                account: "Fixture Writer",
                scopes: "openid profile w_member_social",
                expiresAt: "2026-01-01T00:00:00Z",
                connectedAt: null,
                disconnectedAt: null,
              },
              health: { state: "ok" },
            },
          ])
        : original(input, init),
    );
    await renderAsync(<Page params={Promise.resolve({ id: brandId })} />);
    expect(await screen.findByText(en.LinkedIn.states.expired)).toBeVisible();
    expect(screen.queryByText(en.Channels.health.ok)).not.toBeInTheDocument();
  });

  it("connects through verified OAuth and never offers fields for pasted credentials", async () => {
    const requests: unknown[] = [];
    install(undefined, (init) => {
      requests.push(JSON.parse(String(init?.body)));
      return body(200, {
        authorizationUrl: "https://www.linkedin.com/oauth/v2/authorization?state=fixture",
      });
    });
    await renderAsync(<Page params={Promise.resolve({ id: brandId })} />);
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByRole("combobox"), "linkedin");
    expect(screen.getByText(en.LinkedIn.connectHint)).toBeVisible();
    expect(screen.queryByLabelText(credentialFieldLabel("accessToken"))).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(en.Channels.namePlaceholder), "Personal writer");
    const connect = await screen.findByRole("button", { name: en.LinkedIn.connect });
    await waitFor(() => expect(connect).toBeEnabled());
    await user.click(connect);
    expect(requests).toEqual([{ brandId, name: "Personal writer", locale: "en" }]);
    expect(linkedinAuthorizationStartSchema.parse(requests[0])).toEqual(requests[0]);
    expect(openLinkedInAuthorization).toHaveBeenCalledOnce();
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(
          ([input, init]) => String(input).endsWith("/api/channels") && init?.method === "POST",
        ),
    ).toBe(false);
  });
  it("shows unavailable operator configuration and prevents a doomed authorization request", async () => {
    install(() => body(200, { available: false }));
    await renderAsync(<Page params={Promise.resolve({ id: brandId })} />);
    await userEvent.setup().selectOptions(await screen.findByRole("combobox"), "linkedin");
    expect(await screen.findByText(en.LinkedIn.configurationUnavailable)).toBeVisible();
    expect(screen.getByRole("button", { name: en.LinkedIn.connect })).toBeDisabled();
    expect(openLinkedInAuthorization).not.toHaveBeenCalled();
  });
  it("offers a localized configuration retry without discarding the user's channel name", async () => {
    let reads = 0;
    install(() =>
      ++reads === 1
        ? body(503, { code: "linkedin_unavailable", message: "Server prose" })
        : body(200, { available: true }),
    );
    await renderAsync(<Page params={Promise.resolve({ id: brandId })} />, { locale: "ru" });
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByRole("combobox"), "linkedin");
    await user.type(screen.getByLabelText(ru.Channels.namePlaceholder), "Мой аккаунт");
    expect(await screen.findByRole("alert")).toHaveTextContent(ru.Errors.linkedin_unavailable);
    await user.click(screen.getByRole("button", { name: ru.LinkedIn.retry }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: ru.LinkedIn.connect })).toBeEnabled(),
    );
    expect(screen.getByLabelText(ru.Channels.namePlaceholder)).toHaveValue("Мой аккаунт");
    expect(reads).toBe(2);
  });
  it("localizes start failure and retains the name for a fresh attempt", async () => {
    install(undefined, () =>
      body(409, refusalBody(409, "linkedin_authority_changed", "Server prose")),
    );
    await renderAsync(<Page params={Promise.resolve({ id: brandId })} />, { locale: "ru" });
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByRole("combobox"), "linkedin");
    await user.type(screen.getByLabelText(ru.Channels.namePlaceholder), "Мой аккаунт");
    const connect = screen.getByRole("button", { name: ru.LinkedIn.connect });
    await waitFor(() => expect(connect).toBeEnabled());
    await user.click(connect);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      ru.Errors.linkedin_authority_changed,
    );
    expect(screen.getByLabelText(ru.Channels.namePlaceholder)).toHaveValue("Мой аккаунт");
    expect(openLinkedInAuthorization).not.toHaveBeenCalled();
  });
  it("keeps OAuth-only creation unavailable to nonmanagers", async () => {
    install();
    vi.mocked(authClient.useActiveOrganization).mockReturnValue({
      data: { id: "test-org", members: [{ userId: "test-user", role: "member" }] },
      isPending: false,
    } as never);
    await renderAsync(<Page params={Promise.resolve({ id: brandId })} />);
    const option = await screen.findByRole("option", { name: "LinkedIn" });
    expect(option).toBeDisabled();
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([input]) =>
          String(input).includes("/api/channels/linkedin/configuration"),
        ),
    ).toBe(false);
  });
  it("localizes invalid WordPress destination refusal before credential retention", async () => {
    install();
    const original = vi.mocked(fetch).getMockImplementation();
    if (!original) throw new Error("fixture fetch implementation missing");
    vi.mocked(fetch).mockImplementation(async (input, init) =>
      String(input).endsWith("/api/channels") && init?.method === "POST"
        ? body(400, refusalBody(400, "invalid_request", "The connection destination is invalid"))
        : original(input, init),
    );
    await renderAsync(<Page params={Promise.resolve({ id: brandId })} />, { locale: "ru" });
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByRole("combobox"), "wordpress");
    await user.type(screen.getByLabelText(ru.Channels.namePlaceholder), "Journal");
    for (const [key, value] of Object.entries({
      siteUrl: "https://127.0.0.1/blog",
      username: "editor",
      applicationPassword: "synthetic-secret",
    }))
      await user.type(screen.getByLabelText(credentialFieldLabel(key)), value);
    await user.click(screen.getByRole("button", { name: ru.Channels.add }));
    expect(await screen.findByRole("alert")).toHaveTextContent(ru.Errors.invalid_request);
    expect(screen.getByLabelText(credentialFieldLabel("siteUrl"))).toHaveValue(
      "https://127.0.0.1/blog",
    );
  });
});
