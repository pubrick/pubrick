import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Card } from "./card";

describe("Card", () => {
  it("renders its children", () => {
    render(
      <Card>
        <p>Body</p>
      </Card>,
    );
    expect(screen.getByText("Body")).toBeInTheDocument();
  });

  it("is padded by default", () => {
    const { container } = render(
      <Card>
        <p>Body</p>
      </Card>,
    );
    expect(container.firstElementChild?.className).toContain("p-4");
  });

  it("omits padding when padded=false", () => {
    const { container } = render(
      <Card padded={false}>
        <p>Body</p>
      </Card>,
    );
    expect(container.firstElementChild?.className).not.toContain("p-4");
  });
});
