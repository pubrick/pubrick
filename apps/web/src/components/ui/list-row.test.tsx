import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ListRow } from "./list-row";

describe("ListRow", () => {
  it("renders a <div> when no href is given", () => {
    const { container } = render(<ListRow title="First post" meta="Draft" />);
    expect(container.firstElementChild?.tagName).toBe("DIV");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("renders an <a> when href is given", () => {
    render(<ListRow title="First post" href="/content/123" />);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/content/123");
    expect(link).toHaveTextContent("First post");
  });

  it("renders meta and trailing content when provided", () => {
    render(<ListRow title="First post" meta="Draft" trailing={<span>Chip</span>} />);
    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.getByText("Chip")).toBeInTheDocument();
  });

  it("omits meta when not provided", () => {
    render(<ListRow title="First post" />);
    expect(screen.queryByText("Draft")).not.toBeInTheDocument();
  });
});
