import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Menu } from "./menu";

const items = [
  { label: "Edit", onSelect: vi.fn() },
  { label: "Delete", onSelect: vi.fn(), danger: true },
];

describe("Menu", () => {
  it("is closed by default and opens the panel on trigger click", () => {
    render(<Menu trigger="Options" items={items} />);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Options"));

    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getAllByRole("menuitem")).toHaveLength(2);
  });

  it("closes on Escape", () => {
    render(<Menu trigger="Options" items={items} />);
    fireEvent.click(screen.getByText("Options"));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("closes on an outside click", () => {
    render(
      <div>
        <div data-testid="outside">Elsewhere</div>
        <Menu trigger="Options" items={items} />
      </div>,
    );
    fireEvent.click(screen.getByText("Options"));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByTestId("outside"));

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("calls the item's onSelect and closes the menu when an item is clicked", () => {
    const onSelect = vi.fn();
    render(<Menu trigger="Options" items={[{ label: "Edit", onSelect }]} />);
    fireEvent.click(screen.getByText("Options"));

    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("removes every global listener it added, once unmounted (no leak)", () => {
    // Dispatching an event after unmount never throws either way — a
    // dangling `document` listener just silently calls a dead component's
    // setState, which React swallows in a test environment. The only
    // signal that actually distinguishes "cleaned up" from "leaked" is
    // whether removeEventListener was called to match every
    // addEventListener the component made — so spy on both and assert
    // they balance, rather than asserting on an event dispatch.
    const addSpy = vi.spyOn(document, "addEventListener");
    const removeSpy = vi.spyOn(document, "removeEventListener");

    const { unmount } = render(<Menu trigger="Options" items={items} />);
    fireEvent.click(screen.getByText("Options"));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    const globalEventTypes = ["mousedown", "keydown"];
    const addedTypes = addSpy.mock.calls
      .map(([type]) => type)
      .filter((type): type is string => globalEventTypes.includes(type as string))
      .sort();
    // Sanity check on the spy itself: if this is empty, the assertion
    // below would pass vacuously (0 added == 0 removed) without ever
    // having exercised the leak this test exists to catch.
    expect(addedTypes).toEqual(["keydown", "mousedown"]);

    unmount();

    const removedTypes = removeSpy.mock.calls
      .map(([type]) => type)
      .filter((type): type is string => globalEventTypes.includes(type as string))
      .sort();
    expect(removedTypes).toEqual(addedTypes);

    addSpy.mockRestore();
    removeSpy.mockRestore();
  });
});
