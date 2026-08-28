import { fireEvent } from "@testing-library/react";
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
