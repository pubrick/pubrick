import { describe, expect, it } from "vitest";
import { navigationState } from "@/test/next-navigation.stub";
import { render, screen, within } from "@/test/render";
import en from "../../messages/en.json";
import { AppShell } from "./app-shell";

describe("AppShell navigation", () => {
  it("renders Queue, Brands and Settings with the right hrefs, Settings last", () => {
    render(<AppShell title="Queue">content</AppShell>);

    const nav = screen.getByRole("navigation", { name: en.Nav.label });
    const links = within(nav).getAllByRole("link");

    // Order matters: the constitution requires Queue, Brands, [spacer],
    // Settings LAST — proved here by the exact href sequence, not just set
    // membership.
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/en/content",
      "/en/brands",
      "/en/settings",
    ]);
  });

  it("gives every nav destination its translated accessible name", () => {
    render(<AppShell title="Queue">content</AppShell>);

    const nav = screen.getByRole("navigation", { name: en.Nav.label });
    expect(within(nav).getByRole("link", { name: en.Nav.queue })).toHaveAttribute(
      "href",
      "/en/content",
    );
    expect(within(nav).getByRole("link", { name: en.Nav.brands })).toHaveAttribute(
      "href",
      "/en/brands",
    );
    expect(within(nav).getByRole("link", { name: en.Nav.settings })).toHaveAttribute(
      "href",
      "/en/settings",
    );
  });

  it("marks only the destination matching the current pathname as active", () => {
    navigationState.pathname = "/en/brands";
    render(<AppShell title="Brands">content</AppShell>);

    const nav = screen.getByRole("navigation", { name: en.Nav.label });
    expect(within(nav).getByRole("link", { name: en.Nav.brands })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(nav).getByRole("link", { name: en.Nav.queue })).not.toHaveAttribute(
      "aria-current",
    );
    expect(within(nav).getByRole("link", { name: en.Nav.settings })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("treats a sub-route (e.g. /en/content/42) as still under its section", () => {
    navigationState.pathname = "/en/content/42";
    render(<AppShell title="Item">content</AppShell>);

    const nav = screen.getByRole("navigation", { name: en.Nav.label });
    expect(within(nav).getByRole("link", { name: en.Nav.queue })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("renders the page title and the children passed to it", () => {
    render(<AppShell title="My Title">the page body</AppShell>);

    expect(screen.getByRole("heading", { level: 1, name: "My Title" })).toBeInTheDocument();
    expect(screen.getByText("the page body")).toBeInTheDocument();
  });
});
