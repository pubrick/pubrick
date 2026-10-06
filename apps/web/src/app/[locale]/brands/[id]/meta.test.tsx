import {
  META_CONNECTION_PROVIDERS,
  metaAuthorizationStartSchema,
  refusalBody,
} from "@pubrick/shared";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authClient } from "@/lib/auth-client";
import { openMetaAuthorization } from "@/lib/meta-connections";
import { credentialFieldLabel } from "@/lib/platform";
import { signedInSession } from "@/test/auth-client.stub";
import { renderAsync } from "@/test/render";
import en from "../../../../../messages/en.json";
import ru from "../../../../../messages/ru.json";
import Page from "./page";

vi.mock("@/lib/meta-connections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/meta-connections")>()),
  openMetaAuthorization: vi.fn(),
}));
const brandId = "b669ae6d-4bc8-4650-9f42-588798682198";
const body = (status: number, value: unknown) => new Response(JSON.stringify(value), { status });
const configuration = (available = true) => ({
  providers: META_CONNECTION_PROVIDERS.map((provider) => ({ provider, available })),
});
beforeEach(() => {
  signedInSession();
  vi.mocked(authClient.useActiveOrganization).mockReturnValue({
    data: { id: "test-org", members: [{ userId: "test-user", role: "admin" }] },
    isPending: false,
  } as never);
  vi.stubGlobal("fetch", vi.fn());
  vi.mocked(openMetaAuthorization).mockReset();
});
function install(
  config: () => Response | Promise<Response> = () => body(200, configuration()),
  channels: unknown[] = [],
) {
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes("/api/channels/meta/configuration")) return config();
    if (url.endsWith("/api/channels/meta/authorize")) {
      const provider = JSON.parse(String(init?.body)).provider;
      return body(200, { provider, authorizationUrl: "fixture" });
    }
    if (url.includes("/api/channels?brandId=")) return body(200, channels);
    if (url.endsWith(`/api/brands/${brandId}`)) return body(200, { id: brandId, name: "Writing" });
    return body(200, {});
  });
}
describe("brand Meta OAuth entry", () => {
  it.each(META_CONNECTION_PROVIDERS)(
    "offers %s as its own OAuth choice without pasted credentials",
    async (provider) => {
      install();
      await renderAsync(<Page params={Promise.resolve({ id: brandId })} />);
      const user = userEvent.setup();
      await user.selectOptions(
        await screen.findByRole("combobox", { name: en.Channels.platformLabel }),
        provider,
      );
      expect(screen.getByText(en.MetaConnections.personalOnly)).toBeVisible();
      expect(screen.getByText(en.MetaConnections.capability[provider])).toBeVisible();
      expect(screen.queryByLabelText(credentialFieldLabel("accessToken"))).not.toBeInTheDocument();
      await user.type(screen.getByLabelText(en.Channels.namePlaceholder), "Studio writer");
      const connect = screen.getByRole("button", { name: en.MetaConnections.connect });
      expect(connect).toHaveClass("min-h-11");
      await waitFor(() => expect(connect).toBeEnabled());
      await user.click(connect);
      const writes = vi
        .mocked(fetch)
        .mock.calls.filter(
          ([url, init]) =>
            String(url).endsWith("/api/channels/meta/authorize") && init?.method === "POST",
        );
      expect(writes).toHaveLength(1);
      const sent = JSON.parse(String(writes[0]?.[1]?.body));
      expect(sent).toEqual({ provider, brandId, name: "Studio writer", locale: "en" });
      expect(metaAuthorizationStartSchema.parse(sent)).toEqual(sent);
      expect(openMetaAuthorization).toHaveBeenCalledExactlyOnceWith(provider, {
        provider,
        authorizationUrl: "fixture",
      });
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(
            ([url, init]) => String(url).endsWith("/api/channels") && init?.method === "POST",
          ),
      ).toBe(false);
    },
  );
  it("reports configured-unavailable honestly and refuses any authorization write", async () => {
    install(() => body(200, configuration(false)));
    await renderAsync(<Page params={Promise.resolve({ id: brandId })} />);
    await userEvent
      .setup()
      .selectOptions(screen.getByRole("combobox", { name: en.Channels.platformLabel }), "threads");
    expect(await screen.findByText(en.MetaConnections.unavailable)).toBeVisible();
    expect(screen.getByRole("button", { name: en.MetaConnections.connect })).toBeDisabled();
    expect(openMetaAuthorization).not.toHaveBeenCalled();
  });
  it("offers a localized retry after a configuration failure without treating it as unavailable", async () => {
    let reads = 0;
    install(() =>
      ++reads === 1
        ? body(403, refusalBody(403, "meta_authority_changed", "Server prose"))
        : body(200, configuration()),
    );
    await renderAsync(<Page params={Promise.resolve({ id: brandId })} />, { locale: "ru" });
    const user = userEvent.setup();
    await user.selectOptions(
      screen.getByRole("combobox", { name: ru.Channels.platformLabel }),
      "threads",
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(ru.Errors.meta_authority_changed);
    expect(screen.queryByText(ru.MetaConnections.unavailable)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: ru.MetaConnections.retry }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: ru.MetaConnections.connect })).toBeEnabled(),
    );
    expect(reads).toBe(2);
  });
  it("ignores a late configuration response for the previously selected provider", async () => {
    let first!: (value: Response) => void;
    let reads = 0;
    install(() =>
      ++reads === 1
        ? new Promise((resolve) => {
            first = resolve;
          })
        : body(200, configuration(false)),
    );
    await renderAsync(<Page params={Promise.resolve({ id: brandId })} />);
    const user = userEvent.setup();
    const picker = screen.getByRole("combobox", { name: en.Channels.platformLabel });
    await user.selectOptions(picker, "threads");
    await waitFor(() => expect(reads).toBe(1));
    await user.selectOptions(picker, "instagram_native");
    await screen.findByText(en.MetaConnections.unavailable);
    await act(async () => first(body(200, configuration(true))));
    expect(screen.getByRole("button", { name: en.MetaConnections.connect })).toBeDisabled();
    expect(screen.getByText(en.MetaConnections.unavailable)).toBeVisible();
  });
  it("uses exact current-user role union regardless of duplicate membership ordering", async () => {
    install();
    vi.mocked(authClient.useActiveOrganization).mockReturnValue({
      data: {
        id: "test-org",
        members: [
          { userId: "test-user", role: "author" },
          { userId: "test-user", role: "admin" },
        ],
      },
      isPending: false,
    } as never);
    await renderAsync(<Page params={Promise.resolve({ id: brandId })} />);
    await userEvent
      .setup()
      .selectOptions(screen.getByRole("combobox", { name: en.Channels.platformLabel }), "threads");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: en.MetaConnections.connect })).toBeEnabled(),
    );
  });
  it("does not expose Meta manager actions to a legacy member", async () => {
    install();
    vi.mocked(authClient.useActiveOrganization).mockReturnValue({
      data: { id: "test-org", members: [{ userId: "test-user", role: "member" }] },
      isPending: false,
    } as never);
    await renderAsync(<Page params={Promise.resolve({ id: brandId })} />);
    for (const provider of META_CONNECTION_PROVIDERS)
      expect(
        screen.getByRole("option", { name: en.MetaConnections.providers[provider] }),
      ).toBeDisabled();
  });
  it("does not elevate a padded manager role token", async () => {
    install();
    vi.mocked(authClient.useActiveOrganization).mockReturnValue({
      data: {
        id: "test-org",
        members: [
          { userId: "test-user", role: "member" },
          { userId: "test-user", role: " admin " },
        ],
      },
      isPending: false,
    } as never);
    await renderAsync(<Page params={Promise.resolve({ id: brandId })} />);
    for (const provider of META_CONNECTION_PROVIDERS)
      expect(
        screen.getByRole("option", { name: en.MetaConnections.providers[provider] }),
      ).toBeDisabled();
  });
  it("shows native expiry instead of a contradictory cached healthy badge", async () => {
    install(undefined, [
      {
        id: "250b3665-6484-4c6f-bf08-6f8f9a96e544",
        name: "Studio",
        platform: "threads",
        health: { state: "ok" },
        connection: {
          state: "expired",
          generation: 1,
          account: "Studio account",
          scopes: "threads_basic threads_content_publish",
          expiresAt: "2026-01-01T00:00:00Z",
          connectedAt: null,
          disconnectedAt: null,
        },
      },
    ]);
    await renderAsync(<Page params={Promise.resolve({ id: brandId })} />);
    expect(await screen.findByText(en.MetaConnections.states.expired)).toBeVisible();
    expect(screen.queryByText(en.Channels.health.ok)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: en.MetaConnections.reconnect })).toHaveClass(
      "min-h-11",
    );
  });
  it("keeps the original Instagram manual workflow separate", async () => {
    install();
    await renderAsync(<Page params={Promise.resolve({ id: brandId })} />);
    const user = userEvent.setup();
    await user.selectOptions(
      screen.getByRole("combobox", { name: en.Channels.platformLabel }),
      "instagram",
    );
    await user.type(screen.getByLabelText(en.Channels.namePlaceholder), "Manual studio");
    await user.click(screen.getByRole("button", { name: en.Channels.add }));
    expect(openMetaAuthorization).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([url]) => String(url).includes("/api/channels/meta/configuration")),
    ).toBe(false);
    const writes = vi
      .mocked(fetch)
      .mock.calls.filter(
        ([url, init]) => String(url).endsWith("/api/channels") && init?.method === "POST",
      );
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0]?.[1]?.body))).toEqual({
      brandId,
      platform: "instagram",
      name: "Manual studio",
    });
  });
});
