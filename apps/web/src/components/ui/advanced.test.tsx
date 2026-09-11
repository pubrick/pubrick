import { fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import en from "../../../messages/en.json";
import { render, screen, waitFor } from "../../test/render";
import { Advanced } from "./advanced";

/** The disclosure's own trigger. `<summary>` has no role RTL can query by. */
function trigger(container: HTMLElement): HTMLElement {
  const summary = container.querySelector("summary");
  if (!summary) throw new Error("no <summary> rendered");
  return summary as HTMLElement;
}

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

  /**
   * THE DOT IS PAINT, and a person who cannot see paint has to be told the same
   * thing. It is `aria-hidden` (correctly — it is a decoration, not content),
   * which left a collapsed section holding 8 000 characters completely absent
   * from what a screen reader announces: the compose screen's primary action
   * then refuses over material its reader has no way to know is there.
   *
   * On the TRIGGER rather than as loose text, because the trigger is the thing
   * being described and the only element a reader lands on while the section is
   * shut.
   */
  it("describes the trigger when dirty, and says nothing when it is not", () => {
    const { container, rerender } = render(
      <Advanced>
        <p>Content</p>
      </Advanced>,
    );
    expect(trigger(container)).not.toHaveAccessibleDescription();

    rerender(
      <Advanced dirty>
        <p>Content</p>
      </Advanced>,
    );
    expect(trigger(container)).toHaveAccessibleDescription(en.Ui.advancedDirtyHint);
  });

  /**
   * A screen may need to OPEN this — the compose screen's refusal names what is
   * in here, and a refusal about something invisible is the constitution's own
   * complaint. Optional: pass neither prop and the native `<details>` behaves
   * exactly as it always has, which is what every other caller relies on.
   */
  it("can be opened by the screen that owns it, and reports the reader's own toggle back", async () => {
    const seen: boolean[] = [];
    const { container, rerender } = render(
      <Advanced open={false} onOpenChange={(next) => seen.push(next)}>
        <p>Secret content</p>
      </Advanced>,
    );
    expect(screen.getByText("Secret content")).not.toBeVisible();

    rerender(
      <Advanced open onOpenChange={(next) => seen.push(next)}>
        <p>Secret content</p>
      </Advanced>,
    );
    expect(screen.getByText("Secret content")).toBeVisible();

    // `toggle` is queued by the DOM rather than dispatched with the click, so
    // the report arrives a task later — which is exactly how a screen holding
    // this state receives a reader's own close.
    fireEvent.click(trigger(container));
    await waitFor(() => expect(seen).toContain(false));
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
