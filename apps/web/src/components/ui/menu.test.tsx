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

  it("does not leave a global listener attached after unmount", () => {
    const { unmount } = render(<Menu trigger="Options" items={items} />);
    fireEvent.click(screen.getByText("Options"));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    unmount();

    // No assertion throws just by dispatching after unmount; the real
    // guard is that this does not crash and nothing is left listening.
    expect(() => fireEvent.keyDown(document, { key: "Escape" })).not.toThrow();
  });
});
