import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Segmented } from "./segmented";

const THREE = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** The real usage: the parent owns the value, so selection actually moves. */
function Controlled({ initial = "system" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return <Segmented options={THREE} value={value} onChange={setValue} />;
}

describe("Segmented", () => {
  it("renders a tablist of tabs with the selected one marked", () => {
    render(<Controlled />);
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.getByRole("tab", { name: "System" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Light" })).toHaveAttribute("aria-selected", "false");
  });

  it("reports the chosen value on click", async () => {
    const onChange = vi.fn();
    render(<Segmented options={THREE} value="system" onChange={onChange} />);

    await userEvent.setup().click(screen.getByRole("tab", { name: "Dark" }));

    expect(onChange).toHaveBeenCalledWith("dark");
  });
});

/**
 * A tablist is a COMPOSITE widget, and the role promises a keyboard model:
 * one tab stop for the whole strip, arrows to move within it. This control
 * declared the role and gave every option its own Tab stop with no arrow keys
 * at all — so a keyboard user tabbing through Settings hit three stops that
 * announced themselves as tabs and answered none of the keys a tab answers.
 */
describe("Segmented keyboard model", () => {
  function tabbable() {
    return screen.getAllByRole("tab").filter((tab) => tab.tabIndex === 0);
  }

  it("is one tab stop, and it is the selected option", () => {
    render(<Controlled initial="light" />);

    expect(tabbable()).toHaveLength(1);
    expect(tabbable()[0]).toHaveAccessibleName("Light");
  });

  it("stays one tab stop after the selection moves", async () => {
    render(<Controlled />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("tab", { name: "Dark" }));

    expect(tabbable()).toHaveLength(1);
    expect(tabbable()[0]).toHaveAccessibleName("Dark");
  });

  it("keeps one tab stop even when the value matches no option", () => {
    // A filter restored from a URL whose status no longer exists. Every button
    // at tabIndex -1 would make the whole control unreachable by Tab.
    render(<Segmented options={THREE} value="nonsense" onChange={vi.fn()} />);

    expect(tabbable()).toHaveLength(1);
  });

  it("moves and selects with ArrowRight, wrapping past the last option", async () => {
    render(<Controlled />);
    const user = userEvent.setup();
    screen.getByRole("tab", { name: "System" }).focus();

    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Light" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Light" })).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(screen.getByRole("tab", { name: "System" })).toHaveFocus();
  });

  it("moves and selects with ArrowLeft, wrapping past the first option", async () => {
    render(<Controlled />);
    const user = userEvent.setup();
    screen.getByRole("tab", { name: "System" }).focus();

    await user.keyboard("{ArrowLeft}");

    expect(screen.getByRole("tab", { name: "Dark" })).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Dark" })).toHaveAttribute("aria-selected", "true");
  });

  it("jumps to the ends with Home and End", async () => {
    render(<Controlled initial="light" />);
    const user = userEvent.setup();
    screen.getByRole("tab", { name: "Light" }).focus();

    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "Dark" })).toHaveFocus();

    await user.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: "System" })).toHaveFocus();
  });

  it("leaves the strip on Tab rather than walking to the next option", async () => {
    render(
      <>
        <Controlled />
        <button type="button">After</button>
      </>,
    );
    const user = userEvent.setup();
    screen.getByRole("tab", { name: "System" }).focus();

    await user.tab();

    expect(screen.getByRole("button", { name: "After" })).toHaveFocus();
  });
});
