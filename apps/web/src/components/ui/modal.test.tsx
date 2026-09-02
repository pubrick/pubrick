import { fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "../../test/render";
import { Modal } from "./modal";

describe("Modal", () => {
  it("renders nothing when open is false", () => {
    const { container } = render(
      <Modal open={false} onClose={vi.fn()} title="Delete brand">
        <p>Are you sure?</p>
      </Modal>,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders role=dialog with aria-modal when open", () => {
    render(
      <Modal open onClose={vi.fn()} title="Delete brand">
        <p>Are you sure?</p>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("moves focus into the dialog on open", () => {
    render(
      <Modal open onClose={vi.fn()} title="Delete brand">
        <p>Are you sure?</p>
      </Modal>,
    );
    expect(screen.getByRole("dialog")).toHaveFocus();
  });

  it("calls onClose exactly once when Escape is pressed", () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Delete brand">
        <p>Are you sure?</p>
      </Modal>,
    );

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose for a non-Escape key", () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Delete brand">
        <p>Are you sure?</p>
      </Modal>,
    );

    fireEvent.keyDown(document, { key: "Enter" });

    expect(onClose).not.toHaveBeenCalled();
  });

  it("renders the title and children", () => {
    render(
      <Modal open onClose={vi.fn()} title="Delete brand">
        <p>Are you sure?</p>
      </Modal>,
    );
    expect(screen.getByText("Delete brand")).toBeInTheDocument();
    expect(screen.getByText("Are you sure?")).toBeInTheDocument();
  });

  it("renders the footer when provided", () => {
    render(
      <Modal
        open
        onClose={vi.fn()}
        title="Delete brand"
        footer={<button type="button">Confirm</button>}
      >
        <p>Are you sure?</p>
      </Modal>,
    );
    expect(screen.getByRole("button", { name: "Confirm" })).toBeInTheDocument();
  });

  it("does not leave a global keydown listener attached after unmount", () => {
    const onClose = vi.fn();
    const { unmount } = render(
      <Modal open onClose={onClose} title="Delete brand">
        <p>Are you sure?</p>
      </Modal>,
    );

    unmount();
    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).not.toHaveBeenCalled();
  });
});

/**
 * The trap, proven the only way that means anything: press Tab and look at
 * where focus ended up.
 *
 * `aria-modal="true"` takes the page behind out of the ACCESSIBILITY tree and
 * out of nothing else, so before this the page's own controls were still in
 * the browser's tab order — four Tab presses out of "Discard your draft?"
 * landed on the page's buttons, invisible behind the overlay and unclickable
 * (the backdrop eats the pointer). The fixture below is that exact shape: real
 * focusables before AND after the dialog in DOM order, so a leak in either
 * direction has somewhere to leak to.
 */
describe("Modal focus trap", () => {
  function Fixture() {
    return (
      <>
        <button type="button">Before the dialog</button>
        <Modal
          open
          onClose={vi.fn()}
          title="Discard your draft?"
          footer={
            <>
              <button type="button">Cancel</button>
              <button type="button">Discard and generate</button>
            </>
          }
        >
          <input aria-label="Note" />
        </Modal>
        <button type="button">After the dialog</button>
      </>
    );
  }

  /** Every control the trap is allowed to leave focus on. */
  function insideDialog(): boolean {
    const dialog = screen.getByRole("dialog");
    return document.activeElement !== null && dialog.contains(document.activeElement);
  }

  it("keeps Tab inside the dialog — six presses never reach the page behind", async () => {
    render(<Fixture />);
    const user = userEvent.setup();
    expect(screen.getByRole("dialog")).toHaveFocus();

    // The dialog holds four focusables (Close, Note, Cancel, Discard), so six
    // presses wrap past the end twice over. Asserted after EVERY press: a trap
    // that only catches the last one would pass a single end-state check.
    for (let press = 0; press < 6; press++) {
      await user.tab();
      expect(insideDialog()).toBe(true);
    }
  });

  it("keeps Shift+Tab inside the dialog — backwards off the first control wraps to the last", async () => {
    render(<Fixture />);
    const user = userEvent.setup();

    for (let press = 0; press < 6; press++) {
      await user.tab({ shift: true });
      expect(insideDialog()).toBe(true);
    }
  });

  it("never lands on the two buttons that are behind the overlay", async () => {
    render(<Fixture />);
    const user = userEvent.setup();
    const before = screen.getByRole("button", { name: "Before the dialog" });
    const after = screen.getByRole("button", { name: "After the dialog" });

    for (let press = 0; press < 8; press++) {
      await user.tab();
      expect(document.activeElement).not.toBe(before);
      expect(document.activeElement).not.toBe(after);
    }
  });

  it("reaches every control in the dialog rather than pinning focus to one", async () => {
    // The cheapest wrong "trap" is one that swallows Tab entirely. This is the
    // half of the contract that catches it.
    render(<Fixture />);
    const user = userEvent.setup();

    const seen = new Set<Element>();
    for (let press = 0; press < 5; press++) {
      await user.tab();
      if (document.activeElement) seen.add(document.activeElement);
    }

    expect(seen.has(screen.getByLabelText("Note"))).toBe(true);
    expect(seen.has(screen.getByRole("button", { name: "Cancel" }))).toBe(true);
    expect(seen.has(screen.getByRole("button", { name: "Discard and generate" }))).toBe(true);
  });

  it("pulls focus back in when Tab is pressed from outside the dialog", async () => {
    render(<Fixture />);
    const user = userEvent.setup();
    // A modal opened from a control the click left focused elsewhere: focus is
    // outside the dialog when the first Tab arrives.
    screen.getByRole("button", { name: "Before the dialog" }).focus();

    await user.tab();

    expect(insideDialog()).toBe(true);
  });

  it("traps Tab even when the dialog holds nothing focusable", async () => {
    render(
      <Modal open onClose={vi.fn()} title="Nothing here">
        <p>Body only.</p>
      </Modal>,
    );
    const user = userEvent.setup();

    await user.tab();

    // The Close button in the header is always there, so this asserts the
    // general shape via the same guard: focus stays in the dialog subtree.
    const dialog = screen.getByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});
