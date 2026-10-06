import {
  metaAuthorizationCompleteSchema,
  metaPageSelectionSchema,
  refusalBody,
} from "@pubrick/shared";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signedInSession } from "@/test/auth-client.stub";
import { navigationState, routerMock } from "@/test/next-navigation.stub";
import { render } from "@/test/render";
import en from "../../../../../../messages/en.json";
import ru from "../../../../../../messages/ru.json";
import Page from "./page";

const brandId = "b669ae6d-4bc8-4650-9f42-588798682198";
const channelId = "250b3665-6484-4c6f-bf08-6f8f9a96e544";
const requestId = "5298c93c-182d-4278-b4fc-6e426f265be7";
const response = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const connected = { status: "connected", brandId, channelId, locale: "ru" };
const choices = () => ({
  status: "choose_page",
  requestId,
  brandId,
  locale: "ru",
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  pages: [
    { id: "111", name: "Studio" },
    { id: "222", name: "Studio" },
  ],
});
function provider(value: string) {
  navigationState.params = { provider: value };
  window.history.replaceState(
    null,
    "",
    `/en/connections/meta/${value}?state=fixture&code=one&code=two#secret`,
  );
}
beforeEach(() => {
  signedInSession();
  vi.stubGlobal("fetch", vi.fn());
  provider("threads");
});
afterEach(() => vi.useRealTimers());
describe("Meta callback and explicit Page choice", () => {
  it.each(["threads", "instagram_native"])(
    "consumes %s once in StrictMode and preserves raw duplicate parameters",
    async (name) => {
      provider(name);
      vi.mocked(fetch).mockResolvedValue(response(200, connected));
      render(
        <StrictMode>
          <Page />
        </StrictMode>,
      );
      await waitFor(() =>
        expect(routerMock.replace).toHaveBeenCalledExactlyOnceWith(
          `/ru/brands/${brandId}#channels`,
        ),
      );
      expect(fetch).toHaveBeenCalledOnce();
      const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));
      expect(body).toEqual({ provider: name, parameters: "state=fixture&code=one&code=two" });
      expect(metaAuthorizationCompleteSchema.parse(body)).toEqual(body);
      expect(window.location.search).toBe("");
      expect(window.location.hash).toBe("");
    },
  );
  it("never auto-selects a Page, distinguishes equal names by ID, and confirms only the chosen Page", async () => {
    provider("facebook_page");
    vi.mocked(fetch)
      .mockResolvedValueOnce(response(200, choices()))
      .mockResolvedValueOnce(response(200, connected));
    render(<Page />);
    const radios = await screen.findAllByRole("radio");
    for (const radio of radios) {
      expect(radio).not.toBeChecked();
      expect(radio.closest("label")).toHaveClass("min-h-11");
    }
    expect(screen.getByText("Page ID: 111")).toBeVisible();
    expect(screen.getByText("Page ID: 222")).toBeVisible();
    const connect = screen.getByRole("button", { name: en.MetaConnections.connectPage });
    expect(connect).toBeDisabled();
    expect(fetch).toHaveBeenCalledOnce();
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "Studio Page ID: 222" }));
    expect(fetch).toHaveBeenCalledOnce();
    await user.click(connect);
    const [url, init] = vi.mocked(fetch).mock.calls[1] ?? [];
    expect(String(url)).toContain("/api/channels/meta/select-page");
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({ requestId, pageId: "222" });
    expect(metaPageSelectionSchema.parse(body)).toEqual(body);
    await waitFor(() =>
      expect(routerMock.replace).toHaveBeenCalledWith(`/ru/brands/${brandId}#channels`),
    );
  });
  it("refuses a choice that expires just before click without issuing a POST", async () => {
    provider("facebook_page");
    const expires = choices();
    vi.mocked(fetch).mockResolvedValueOnce(response(200, expires));
    render(<Page />);
    await screen.findAllByRole("radio");
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "Studio Page ID: 222" }));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(expires.expiresAt) + 1);
    await user.click(screen.getByRole("button", { name: en.MetaConnections.connectPage }));
    expect(fetch).toHaveBeenCalledOnce();
    expect(await screen.findByRole("alert")).toHaveTextContent(en.MetaConnections.selectionExpired);
  });
  it("burns a failed Page selection, localizes refusal, and requires a new authorization", async () => {
    provider("facebook_page");
    vi.mocked(fetch)
      .mockResolvedValueOnce(response(200, choices()))
      .mockResolvedValueOnce(
        response(409, refusalBody(409, "meta_authorization_invalid", "Server prose")),
      );
    render(<Page />, { locale: "ru" });
    await screen.findAllByRole("radio");
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "Studio ID страницы: 222" }));
    await user.click(screen.getByRole("button", { name: ru.MetaConnections.connectPage }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      ru.Errors.meta_authorization_invalid,
    );
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.getByText(ru.MetaConnections.callbackRecovery)).toBeVisible();
    expect(screen.getByRole("link", { name: ru.MetaConnections.backToBrands })).toHaveAttribute(
      "href",
      "/ru/brands",
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(routerMock.replace).not.toHaveBeenCalled();
  });
  it("does not replay a rejected callback and gives a localized recovery route", async () => {
    vi.mocked(fetch).mockResolvedValue(
      response(403, refusalBody(403, "meta_authority_changed", "Server prose")),
    );
    render(<Page />, { locale: "ru" });
    expect(await screen.findByRole("alert")).toHaveTextContent(ru.Errors.meta_authority_changed);
    expect(screen.getByRole("link", { name: ru.MetaConnections.backToBrands })).toHaveAttribute(
      "href",
      "/ru/brands",
    );
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("clears secrets for an unknown provider without invoking a connection endpoint", async () => {
    provider("unknown");
    render(<Page />);
    expect(screen.getByRole("alert")).toHaveTextContent(en.MetaConnections.genericError);
    expect(fetch).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("");
  });
  it("does not accept a malformed destination or Page mode for another provider", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response(200, choices()));
    render(<Page />);
    expect(await screen.findByRole("alert")).toHaveTextContent(en.MetaConnections.genericError);
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(routerMock.replace).not.toHaveBeenCalled();
  });
  it("does not navigate after a callback response resolves following unmount", async () => {
    let finish!: (value: Response) => void;
    vi.mocked(fetch).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(<Page />);
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    view.unmount();
    await act(async () => finish(response(200, connected)));
    expect(routerMock.replace).not.toHaveBeenCalled();
  });
  it("refuses an untrusted callback destination", async () => {
    vi.mocked(fetch).mockResolvedValue(
      response(200, { ...connected, brandId: "//attacker.example.com" }),
    );
    render(<Page />);
    expect(await screen.findByRole("alert")).toHaveTextContent(en.MetaConnections.genericError);
    expect(routerMock.replace).not.toHaveBeenCalled();
  });
  it("drops the old pending selection when the callback provider changes", async () => {
    provider("facebook_page");
    let finish!: (value: Response) => void;
    vi.mocked(fetch)
      .mockResolvedValueOnce(response(200, choices()))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce(response(200, connected));
    const view = render(<Page />);
    await screen.findAllByRole("radio");
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: "Studio Page ID: 222" }));
    await user.click(screen.getByRole("button", { name: en.MetaConnections.connectPage }));
    provider("instagram_native");
    view.rerender(<Page />);
    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledOnce());
    await act(async () =>
      finish(response(200, { ...connected, brandId: "795b295d-6dc2-462d-8ee9-4762f507be6a" })),
    );
    expect(routerMock.replace).toHaveBeenCalledExactlyOnceWith(`/ru/brands/${brandId}#channels`);
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });
});
