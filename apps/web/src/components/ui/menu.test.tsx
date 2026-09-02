import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

/**
 * `role="menu"` is a promise about the keyboard, and this is the promise.
 *
 * The component declared the role and implemented none of it: Enter opened the
 * panel and left focus on the trigger, arrows did nothing, every item was its
 * own Tab stop, and Escape closed the panel while dropping focus on
 * `document.body` — which is no focus at all, on a screen where the thing you
 * were just on has vanished.
 */
describe("Menu keyboard model", () => {
  const three = [
    { label: "Duplicate", onSelect: vi.fn() },
    { label: "Archive", onSelect: vi.fn() },
    { label: "Delete", onSelect: vi.fn(), danger: true },
  ];

  it("moves focus to the first item when opened with Enter", async () => {
    render(<Menu trigger="Options" items={three} />);
    const user = userEvent.setup();
    screen.getByRole("button", { name: "Options" }).focus();

    await user.keyboard("{Enter}");

    expect(screen.getByRole("menuitem", { name: "Duplicate" })).toHaveFocus();
  });

  it("opens on ArrowDown at the first item and on ArrowUp at the last", async () => {
    render(<Menu trigger="Options" items={three} />);
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "Options" });

    trigger.focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Duplicate" })).toHaveFocus();

    await user.keyboard("{Escape}");
    trigger.focus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveFocus();
  });

  it("walks the items with the arrow keys, wrapping at both ends", async () => {
    render(<Menu trigger="Options" items={three} />);
    const user = userEvent.setup();
    await user.click(screen.getByText("Options"));

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Archive" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Duplicate" })).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveFocus();
  });

  it("jumps to the ends with Home and End", async () => {
    render(<Menu trigger="Options" items={three} />);
    const user = userEvent.setup();
    await user.click(screen.getByText("Options"));

    await user.keyboard("{End}");
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(screen.getByRole("menuitem", { name: "Duplicate" })).toHaveFocus();
  });

  it("is one tab stop, not three — a roving tabindex, as the role requires", async () => {
    render(<Menu trigger="Options" items={three} />);
    const user = userEvent.setup();
    await user.click(screen.getByText("Options"));

    const tabbable = () => screen.getAllByRole("menuitem").filter((item) => item.tabIndex === 0);
    expect(tabbable()).toHaveLength(1);
    expect(tabbable()[0]).toHaveAccessibleName("Duplicate");

    await user.keyboard("{ArrowDown}");
    expect(tabbable()).toHaveLength(1);
    expect(tabbable()[0]).toHaveAccessibleName("Archive");
  });

  it("returns focus to the trigger on Escape instead of dropping it on the body", async () => {
    render(<Menu trigger="Options" items={three} />);
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "Options" });
    await user.click(screen.getByText("Options"));

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(document.activeElement).not.toBe(document.body);
  });

  it("returns focus to the trigger after choosing an item", async () => {
    const onSelect = vi.fn();
    render(<Menu trigger="Options" items={[{ label: "Duplicate", onSelect }]} />);
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "Options" });
    await user.click(screen.getByText("Options"));

    await user.keyboard("{Enter}");

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveFocus();
  });

  it("closes when Tab takes focus out, rather than leaving a panel behind the cursor", async () => {
    render(<Menu trigger="Options" items={three} />);
    const user = userEvent.setup();
    await user.click(screen.getByText("Options"));

    await user.tab();

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("reports its open state on the trigger both ways", async () => {
    render(<Menu trigger="Options" items={three} />);
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "Options" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(screen.getByText("Options"));
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    await user.keyboard("{Escape}");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});
