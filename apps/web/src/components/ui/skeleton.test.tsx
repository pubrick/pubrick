import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Skeleton } from "./skeleton";

describe("Skeleton", () => {
  it("renders 3 bars by default", () => {
    const { container } = render(<Skeleton />);
    expect(container.querySelectorAll(":scope > div > div")).toHaveLength(3);
  });

  it("renders the given number of lines", () => {
    const { container } = render(<Skeleton lines={5} />);
    expect(container.querySelectorAll(":scope > div > div")).toHaveLength(5);
  });

  it("is hidden from assistive tech", () => {
    const { container } = render(<Skeleton />);
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
  });
});
