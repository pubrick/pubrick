import type { LinkedInConnection } from "@pubrick/shared";
import {
  linkedinAuthorizationStartSchema,
  linkedinDisconnectSchema,
  refusalBody,
} from "@pubrick/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openLinkedInAuthorization } from "@/lib/linkedin";
import { render } from "@/test/render";
import en from "../../messages/en.json";
import ru from "../../messages/ru.json";
import { LinkedInConnectionActions, LinkedInConnectionSummary } from "./linkedin-connection";

vi.mock("@/lib/linkedin", () => ({ openLinkedInAuthorization: vi.fn() }));
const brandId = "b669ae6d-4bc8-4650-9f42-588798682198";
const id = "250b3665-6484-4c6f-bf08-6f8f9a96e544";
const connection: LinkedInConnection = {
  state: "connected",
  generation: 3,
  account: "Fixture Writer",
  scopes: "openid profile w_member_social",
  expiresAt: "2099-01-01T00:00:00Z",
  connectedAt: "2026-10-01T00:00:00Z",
  disconnectedAt: null,
};
const channel = { id, name: "Personal writing", connection };
const authorizationUrl = "https://www.linkedin.com/oauth/v2/authorization?state=fixture";
const response = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  vi.mocked(openLinkedInAuthorization).mockReset();
});
describe("LinkedIn lifecycle controls", () => {
  it.each(["connected", "disconnected", "expired", "reconnect"] as const)(
    "shows the real %s state and honest text capability",
    (state) => {
      render(<LinkedInConnectionSummary connection={{ ...connection, state }} />);
      expect(screen.getByText(en.LinkedIn.states[state])).toBeVisible();
      expect(screen.getByText(connection.account as string)).toBeVisible();
      expect(screen.getByText(en.LinkedIn.capability)).toBeVisible();
      if (state === "disconnected") expect(screen.queryByText(/Expires/)).not.toBeInTheDocument();
      else expect(screen.getByText(/Expires/)).toBeVisible();
    },
  );
  it("reconnects the saved generation and destination without exposing token fields", async () => {
    vi.mocked(fetch).mockResolvedValue(response(200, { authorizationUrl }));
    render(<LinkedInConnectionActions brandId={brandId} channel={channel} onChanged={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole("button", { name: en.LinkedIn.reconnect }));
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(String(url)).toContain("/api/channels/linkedin/authorize");
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      brandId,
      name: channel.name,
      locale: "en",
      channelId: id,
      expectedGeneration: 3,
    });
    expect(linkedinAuthorizationStartSchema.parse(body)).toEqual(body);
    expect(openLinkedInAuthorization).toHaveBeenCalledWith({ authorizationUrl });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
  it("requires confirmation, keeps jobs/history explicit and sends generation-bound disconnect", async () => {
    vi.mocked(fetch).mockResolvedValue(response(204));
    const changed = vi.fn();
    render(<LinkedInConnectionActions brandId={brandId} channel={channel} onChanged={changed} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.LinkedIn.disconnect }));
    expect(fetch).not.toHaveBeenCalled();
    const modal = screen.getByRole("dialog");
    expect(
      within(modal).getByText(/Scheduled work and publication history are kept/),
    ).toBeVisible();
    await user.click(within(modal).getByRole("button", { name: en.LinkedIn.disconnect }));
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(String(url)).toContain(`/api/channels/linkedin/${id}/disconnect`);
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({ expectedGeneration: 3 });
    expect(linkedinDisconnectSchema.parse(body)).toEqual(body);
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("lets a disconnected account reconnect without another disconnect action", () => {
    render(
      <LinkedInConnectionActions
        brandId={brandId}
        channel={{ ...channel, connection: { ...connection, state: "disconnected" } }}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: en.LinkedIn.reconnect })).toBeEnabled();
    expect(screen.queryByRole("button", { name: en.LinkedIn.disconnect })).not.toBeInTheDocument();
  });
  it("shows a stale-generation refusal in the reader's language and keeps the dialog open", async () => {
    vi.mocked(fetch).mockResolvedValue(
      response(409, refusalBody(409, "linkedin_connection_changed", "Untranslated server text")),
    );
    const changed = vi.fn();
    render(<LinkedInConnectionActions brandId={brandId} channel={channel} onChanged={changed} />, {
      locale: "ru",
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: ru.LinkedIn.disconnect }));
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: ru.LinkedIn.disconnect }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      ru.Errors.linkedin_connection_changed,
    );
    expect(changed).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeVisible();
  });
  it("localizes reconnect failures and does not navigate after refusal", async () => {
    vi.mocked(fetch).mockResolvedValue(
      response(503, { code: "linkedin_unavailable", message: "Untranslated server text" }),
    );
    render(<LinkedInConnectionActions brandId={brandId} channel={channel} onChanged={vi.fn()} />, {
      locale: "ru",
    });
    await userEvent.setup().click(screen.getByRole("button", { name: ru.LinkedIn.reconnect }));
    expect(await screen.findByRole("alert")).toHaveTextContent(ru.Errors.linkedin_unavailable);
    expect(openLinkedInAuthorization).not.toHaveBeenCalled();
  });
  it("blocks repeated submission while a request is pending", async () => {
    let resolve!: (value: Response) => void;
    vi.mocked(fetch).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    render(<LinkedInConnectionActions brandId={brandId} channel={channel} onChanged={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: en.LinkedIn.reconnect }));
    expect(screen.getByRole("button", { name: en.LinkedIn.working })).toBeDisabled();
    expect(fetch).toHaveBeenCalledOnce();
    resolve(response(200, { authorizationUrl }));
    await waitFor(() => expect(openLinkedInAuthorization).toHaveBeenCalledOnce());
  });
});
