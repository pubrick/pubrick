import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { navigationState, routerMock } from "@/test/next-navigation.stub";
import { render, screen } from "@/test/render";
import en from "../../messages/en.json";
import ru from "../../messages/ru.json";
import { LanguageCard } from "./language-card";

/** Sets the address bar jsdom reports, which is where the query is read from. */
function at(url: string) {
  window.history.replaceState({}, "", url);
  navigationState.pathname = new URL(url, "http://localhost").pathname;
}

beforeEach(() => {
  at("/en/settings");
});

afterEach(() => {
  window.history.replaceState({}, "", "/");
  // biome-ignore lint/suspicious/noDocumentCookie: expiring the cookie is the only way to reset jsdom's store between tests, and this is the same API the code under test writes with.
  document.cookie = "NEXT_LOCALE=; path=/; max-age=0";
});

describe("LanguageCard", () => {
  it("names every shipped language in its own language", () => {
    render(<LanguageCard />);

    expect(screen.getByRole("tab", { name: "English" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Español" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Русский" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Português" })).toBeInTheDocument();
  });

  it("titles the card in the reader's own language", () => {
    at("/ru/settings");
    render(<LanguageCard />, { locale: "ru" });

    expect(screen.getByRole("heading", { name: ru.Language.title })).toBeInTheDocument();
    expect(en.Language.title).not.toBe(ru.Language.title);
  });

  it("marks the language currently in the URL as the selected one", () => {
    at("/ru/settings");
    render(<LanguageCard />, { locale: "ru" });

    expect(screen.getByRole("tab", { name: "Русский" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "English" })).toHaveAttribute("aria-selected", "false");
  });

  it("switches to the same screen in the chosen language, query and all", async () => {
    at("/en/content?status=review&brand=b1");
    render(<LanguageCard />);

    await userEvent.setup().click(screen.getByRole("tab", { name: "Español" }));

    expect(routerMock.replace).toHaveBeenCalledWith("/es/content?status=review&brand=b1", {
      scroll: false,
    });
  });

  /**
   * A preference is not a place you navigated to. `push` would leave the screen
   * in the language the reader has just rejected one Back press away — and Back
   * out of a settings screen should return them to where they came from.
   */
  it("leaves no history entry behind", async () => {
    render(<LanguageCard />);

    await userEvent.setup().click(screen.getByRole("tab", { name: "Русский" }));

    expect(routerMock.push).not.toHaveBeenCalled();
    expect(routerMock.replace).toHaveBeenCalledTimes(1);
  });

  it("remembers the choice, so a returning visitor gets it back", async () => {
    render(<LanguageCard />);

    await userEvent.setup().click(screen.getByRole("tab", { name: "Português" }));

    expect(document.cookie).toContain("NEXT_LOCALE=pt");
  });

  /**
   * Choosing the language already in use is not a navigation. It would tear the
   * screen down and build it again — cancelling anything the page has in
   * flight, a running poll included — to arrive at the screen already on
   * display.
   */
  it("does nothing at all when the chosen language is already the active one", async () => {
    render(<LanguageCard />);

    await userEvent.setup().click(screen.getByRole("tab", { name: "English" }));

    expect(routerMock.replace).not.toHaveBeenCalled();
    expect(document.cookie).not.toContain("NEXT_LOCALE=");
  });

  it("moves and switches with the arrow keys, as one tab stop", async () => {
    render(<LanguageCard />);
    const user = userEvent.setup();
    screen.getByRole("tab", { name: "English" }).focus();

    await user.keyboard("{ArrowRight}");

    expect(routerMock.replace).toHaveBeenCalledWith("/es/settings", { scroll: false });
    expect(screen.getByRole("tab", { name: "Español" })).toHaveFocus();
  });
});

/**
 * The switch is a navigation, so everything the current screen holds in memory
 * goes with it. The control's one place is Settings, whose only unsaved input is
 * the credential form — and a typed API key cannot be recovered from anywhere,
 * because no endpoint ever returns one.
 */
describe("LanguageCard with unsaved text on the screen", () => {
  it("asks before throwing the draft away, and does not navigate meanwhile", async () => {
    render(<LanguageCard hasUnsavedText={true} />);

    await userEvent.setup().click(screen.getByRole("tab", { name: "Español" }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(en.Language.confirmBody)).toBeInTheDocument();
    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it("stays put when the confirmation is cancelled", async () => {
    render(<LanguageCard hasUnsavedText={true} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("tab", { name: "Español" }));
    await user.click(screen.getByRole("button", { name: en.Language.confirmCancel }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(routerMock.replace).not.toHaveBeenCalled();
  });

  it("switches once the reader confirms", async () => {
    render(<LanguageCard hasUnsavedText={true} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("tab", { name: "Español" }));
    await user.click(screen.getByRole("button", { name: en.Language.confirmSwitch }));

    expect(routerMock.replace).toHaveBeenCalledWith("/es/settings", { scroll: false });
    expect(document.cookie).toContain("NEXT_LOCALE=es");
  });

  it("never asks about a language that is already the active one", async () => {
    render(<LanguageCard hasUnsavedText={true} />);

    await userEvent.setup().click(screen.getByRole("tab", { name: "English" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

/**
 * The switch is a soft navigation, and a soft navigation across the `[locale]`
 * segment REMOUNTS the tree — confirmed in Chrome, where `document.activeElement`
 * was `<body>` the moment the page came back in Spanish. Left alone, a reader
 * arrowing through the strip is dropped at the top of the document after the
 * first key, which is not what the theme strip this control copies does.
 */
describe("LanguageCard across the navigation it causes", () => {
  it("keeps the reader where they were on the page", async () => {
    render(<LanguageCard />);

    await userEvent.setup().click(screen.getByRole("tab", { name: "Русский" }));

    expect(routerMock.replace).toHaveBeenCalledWith("/ru/settings", { scroll: false });
  });

  it("puts focus back on the language it just switched to", async () => {
    const first = render(<LanguageCard />);
    await userEvent.setup().click(screen.getByRole("tab", { name: "Español" }));

    // What the router does for real: the old tree goes, a new one arrives in
    // the language that was chosen.
    first.unmount();
    at("/es/settings");
    render(<LanguageCard />, { locale: "es" });

    expect(screen.getByRole("tab", { name: "Español" })).toHaveFocus();
  });

  it("takes no focus on an ordinary page load", () => {
    render(<LanguageCard />);

    expect(document.body).toHaveFocus();
  });
});
