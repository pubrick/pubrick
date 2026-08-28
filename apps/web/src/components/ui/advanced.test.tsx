import { fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { render, screen } from "../../test/render";
import { Advanced } from "./advanced";

describe("Advanced", () => {
  it("is collapsed by default — content exists in the DOM but is not visible", () => {
    render(
      <Advanced>
        <p>Secret content</p>
      </Advanced>,
    );
    expect(screen.getByText("Secret content")).not.toBeVisible();
  });

  it("expands on click, revealing the content", () => {
    render(
      <Advanced>
        <p>Secret content</p>
      </Advanced>,
    );

    fireEvent.click(screen.getByText("Advanced"));

    expect(screen.getByText("Secret content")).toBeVisible();
  });

  it("falls back to the Ui.advanced translation when no label prop is given", () => {
    render(
      <Advanced>
        <p>Content</p>
      </Advanced>,
    );
    expect(screen.getByText("Advanced")).toBeInTheDocument();
  });

  it("uses an explicit label prop instead of the translation when given", () => {
    render(
      <Advanced label="More options">
        <p>Content</p>
      </Advanced>,
    );
    expect(screen.getByText("More options")).toBeInTheDocument();
    expect(screen.queryByText("Advanced")).not.toBeInTheDocument();
  });

  /**
   * Mutation-quality proof for the dirty dot (constitution rule 2: hidden
   * non-default state must never be invisible). A single "dot is present
   * when dirty" assertion would still pass an implementation that dropped
   * the `dirty &&` guard and rendered the dot unconditionally — that
   * mutant only dies if a test also asserts the dot's ABSENCE on the
   * (default) non-dirty render. These two assertions together are what
   * makes the condition load-bearing.
   */
  it("renders the dirty dot only when dirty=true — absent by default", () => {
    const { rerender } = render(
      <Advanced>
        <p>Content</p>
      </Advanced>,
    );
    expect(screen.queryByTestId("advanced-dirty-dot")).not.toBeInTheDocument();

    rerender(
      <Advanced dirty>
        <p>Content</p>
      </Advanced>,
    );
    expect(screen.getByTestId("advanced-dirty-dot")).toBeInTheDocument();
  });

  it("does not render the dirty dot when dirty is explicitly false", () => {
    render(
      <Advanced dirty={false}>
        <p>Content</p>
      </Advanced>,
    );
    expect(screen.queryByTestId("advanced-dirty-dot")).not.toBeInTheDocument();
  });
});
