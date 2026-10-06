import {
  type MetaConnection,
  metaAuthorizationStartSchema,
  metaDisconnectSchema,
  refusalBody,
} from "@pubrick/shared";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openMetaAuthorization } from "@/lib/meta-connections";
import { render } from "@/test/render";
import en from "../../messages/en.json";
import ru from "../../messages/ru.json";
import { MetaConnectionActions, MetaConnectionSummary } from "./meta-connection";

vi.mock("@/lib/meta-connections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/meta-connections")>()),
  openMetaAuthorization: vi.fn(),
}));
const brandId = "b669ae6d-4bc8-4650-9f42-588798682198";
const id = "250b3665-6484-4c6f-bf08-6f8f9a96e544";
const connection: MetaConnection = {
  state: "connected",
  generation: 3,
  account: "Studio",
  scopes: "threads_basic threads_content_publish",
  expiresAt: "2099-01-01T00:00:00Z",
  connectedAt: "2026-10-01T00:00:00Z",
  disconnectedAt: null,
};
const channel = { id, name: "Studio writing", connection };
const response = (status: number, value?: unknown) =>
  new Response(value === undefined ? null : JSON.stringify(value), { status });
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  vi.mocked(openMetaAuthorization).mockReset();
});
describe("Meta managed connection controls", () => {
  it.each(["threads", "instagram_native", "facebook_page"] as const)(
    "shows the honest %s capability",
    (provider) => {
      render(<MetaConnectionSummary provider={provider} connection={connection} />);
      expect(screen.getByText(en.MetaConnections.capability[provider])).toBeVisible();
      expect(screen.getByText(en.MetaConnections.states.connected)).toBeVisible();
    },
  );
  it.each(["expired", "disconnected", "reconnect"] as const)(
    "shows actual %s lifecycle state",
    (state) => {
      render(<MetaConnectionSummary provider="threads" connection={{ ...connection, state }} />);
      expect(screen.getByText(en.MetaConnections.states[state])).toBeVisible();
      if (state === "disconnected")
        expect(screen.queryByText(/Access expires/)).not.toBeInTheDocument();
    },
  );
  it.each(["threads", "instagram_native", "facebook_page"] as const)(
    "reconnects %s with the actual saved generation",
    async (provider) => {
      const result = { provider, authorizationUrl: "fixture" };
      vi.mocked(fetch).mockResolvedValue(response(200, result));
      render(
        <MetaConnectionActions
          brandId={brandId}
          provider={provider}
          channel={channel}
          onChanged={vi.fn()}
        />,
      );
      const button = screen.getByRole("button", { name: en.MetaConnections.reconnect });
      expect(button).toHaveClass("min-h-11");
      await userEvent.setup().click(button);
      const [url, init] = vi.mocked(fetch).mock.calls[0] ?? [];
      expect(String(url)).toContain("/api/channels/meta/authorize");
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        provider,
        brandId,
        name: channel.name,
        locale: "en",
        channelId: id,
        expectedGeneration: 3,
      });
      expect(metaAuthorizationStartSchema.parse(body)).toEqual(body);
      expect(openMetaAuthorization).toHaveBeenCalledExactlyOnceWith(provider, result);
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    },
  );
  it("requires explicit confirmation and sends a generation-bound disconnect", async () => {
    vi.mocked(fetch).mockResolvedValue(response(204));
    const changed = vi.fn();
    render(
      <MetaConnectionActions
        brandId={brandId}
        provider="threads"
        channel={channel}
        onChanged={changed}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.MetaConnections.disconnect }));
    expect(fetch).not.toHaveBeenCalled();
    const modal = screen.getByRole("dialog");
    expect(
      within(modal).getByText(/Saved content, schedules and publication history stay available/),
    ).toBeVisible();
    await user.click(within(modal).getByRole("button", { name: en.MetaConnections.disconnect }));
    const [url, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(String(url)).toContain(`/api/channels/meta/${id}/disconnect`);
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({ expectedGeneration: 3 });
    expect(metaDisconnectSchema.parse(body)).toEqual(body);
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  });
  it("shows localized stale-generation refusal and retains confirmation", async () => {
    vi.mocked(fetch).mockResolvedValue(
      response(409, refusalBody(409, "meta_connection_changed", "Server prose")),
    );
    const changed = vi.fn();
    render(
      <MetaConnectionActions
        brandId={brandId}
        provider="threads"
        channel={channel}
        onChanged={changed}
      />,
      { locale: "ru" },
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: ru.MetaConnections.disconnect }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: ru.MetaConnections.disconnect,
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(ru.Errors.meta_connection_changed);
    expect(changed).not.toHaveBeenCalled();
  });
  it("invalidates disconnect confirmation when the viewed connection generation changes", async () => {
    vi.mocked(fetch).mockResolvedValue(response(204));
    const changed = vi.fn();
    const view = render(
      <MetaConnectionActions
        brandId={brandId}
        provider="threads"
        channel={channel}
        onChanged={changed}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.MetaConnections.disconnect }));
    expect(screen.getByRole("dialog")).toBeVisible();
    view.rerender(
      <MetaConnectionActions
        brandId={brandId}
        provider="threads"
        channel={{ ...channel, connection: { ...connection, generation: 4 } }}
        onChanged={changed}
      />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: en.MetaConnections.disconnect }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: en.MetaConnections.disconnect,
      }),
    );
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body))).toEqual({
      expectedGeneration: 4,
    });
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  });
  it("offers explicit reload when generation metadata is missing", async () => {
    const changed = vi.fn();
    render(
      <MetaConnectionActions
        brandId={brandId}
        provider="threads"
        channel={{ id, name: "Legacy" }}
        onChanged={changed}
      />,
    );
    expect(screen.getByRole("button", { name: en.MetaConnections.reconnect })).toBeDisabled();
    await userEvent.setup().click(screen.getByRole("button", { name: en.MetaConnections.reload }));
    expect(changed).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not navigate when a reconnect finishes after unmount", async () => {
    let finish!: (value: Response) => void;
    vi.mocked(fetch).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(
      <MetaConnectionActions
        brandId={brandId}
        provider="threads"
        channel={channel}
        onChanged={vi.fn()}
      />,
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: en.MetaConnections.reconnect }));
    view.unmount();
    await act(async () =>
      finish(response(200, { provider: "threads", authorizationUrl: "fixture" })),
    );
    expect(openMetaAuthorization).not.toHaveBeenCalled();
  });
});
