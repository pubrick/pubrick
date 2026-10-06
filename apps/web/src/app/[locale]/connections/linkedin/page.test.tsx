import { linkedinAuthorizationCompleteSchema, refusalBody } from "@pubrick/shared";
import { screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { signedInSession } from "@/test/auth-client.stub";
import { routerMock } from "@/test/next-navigation.stub";
import { render } from "@/test/render";
import en from "../../../../../messages/en.json";
import ru from "../../../../../messages/ru.json";
import Page from "./page";

const brandId = "b669ae6d-4bc8-4650-9f42-588798682198";
const channelId = "250b3665-6484-4c6f-bf08-6f8f9a96e544";
beforeEach(() => {
  signedInSession();
  vi.stubGlobal("fetch", vi.fn());
  window.history.replaceState(null, "", "/en/connections/linkedin?state=fixture&code=one&code=two");
});
describe("LinkedIn callback recovery", () => {
  it("consumes the callback once in StrictMode, keeps duplicate parameters and strips them from local history", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ brandId, channelId, locale: "ru" }), { status: 200 }),
    );
    render(
      <StrictMode>
        <Page />
      </StrictMode>,
    );
    await waitFor(() =>
      expect(routerMock.replace).toHaveBeenCalledWith(`/ru/brands/${brandId}#channels`),
    );
    const calls = vi
      .mocked(fetch)
      .mock.calls.filter(([input]) => String(input).includes("/api/channels/linkedin/complete"));
    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0]?.[1]?.body));
    expect(body).toEqual({ parameters: "state=fixture&code=one&code=two" });
    expect(linkedinAuthorizationCompleteSchema.parse(body)).toEqual(body);
    expect(window.location.search).toBe("");
  });
  it("offers a fresh authorization route after a localized refusal without replaying the code", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify(refusalBody(409, "linkedin_authorization_invalid", "Server prose")),
        { status: 409 },
      ),
    );
    render(<Page />, { locale: "ru" });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      ru.Errors.linkedin_authorization_invalid,
    );
    expect(screen.getByText(ru.LinkedIn.callbackRecovery)).toBeVisible();
    expect(screen.getByRole("link", { name: ru.LinkedIn.backToBrands })).toHaveAttribute(
      "href",
      "/ru/brands",
    );
    expect(fetch).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: ru.LinkedIn.retry })).not.toBeInTheDocument();
    expect(routerMock.replace).not.toHaveBeenCalled();
  });
  it("does not turn an untrusted response into a router URL", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ brandId: "//attacker.example.com", channelId, locale: "en" }), {
        status: 200,
      }),
    );
    render(<Page />);
    expect(await screen.findByRole("alert")).toHaveTextContent(en.LinkedIn.genericError);
    expect(routerMock.replace).not.toHaveBeenCalled();
  });
});
