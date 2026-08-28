import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmptyState } from "./empty-state";

describe("EmptyState", () => {
  it("renders the title", () => {
    render(<EmptyState title="Create your first brand" />);
    expect(screen.getByText("Create your first brand")).toBeInTheDocument();
  });

  it("renders the action when provided", () => {
    render(
      <EmptyState title="Create your first brand" action={<button type="button">Create</button>} />,
    );
    expect(screen.getByRole("button", { name: "Create" })).toBeInTheDocument();
  });

  it("renders the icon when provided", () => {
    render(<EmptyState title="Create your first brand" icon={<svg data-testid="icon" />} />);
    expect(screen.getByTestId("icon")).toBeInTheDocument();
  });
});
