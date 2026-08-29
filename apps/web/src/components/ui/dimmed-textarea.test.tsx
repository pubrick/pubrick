import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { DimmedTextarea } from "./dimmed-textarea";
import { Textarea } from "./textarea";

/**
 * jsdom has no layout engine: every rect is zero, nothing wraps, `scrollTop`
 * stays 0. So these tests pin what jsdom can actually prove — the character
 * stream, the flags, the attributes — and alignment, scroll sync, forced
 * colors and printing are checked in a browser (design §8). A test asserting
 * "both layers got the same classes" would be a tautology without layout and
 * is deliberately absent.
 */

const AI = "Alpha one. Beta two.\n\nGamma three.";

function Harness(props: { initial: string; aiVersions: string[]; dimmed?: boolean }) {
  const [value, setValue] = useState(props.initial);
  return (
    <DimmedTextarea
      value={value}
      onChange={setValue}
      aiVersions={props.aiVersions}
      dimmed={props.dimmed ?? true}
      label="Body"
      id="b"
    />
  );
}

const flags = () =>
  [...screen.getByTestId("dim-overlay").querySelectorAll("[data-ai]")].map((span) =>
    span.getAttribute("data-ai"),
  );

describe("DimmedTextarea", () => {
  it("renders the overlay character-identical to the textarea's value", () => {
    render(<DimmedTextarea value={AI} onChange={() => {}} aiVersions={[AI]} dimmed label="Body" />);
    const overlay = screen.getByTestId("dim-overlay");
    const textarea = screen.getByLabelText("Body") as HTMLTextAreaElement;
    // The overlay renders slices of the same string. Any character the partition
    // drops is a character the highlight misplaces — in jsdom this is the only
    // way to catch it, since nothing here has layout.
    expect(overlay.textContent).toBe(textarea.value);
  });

  it("keeps the overlay identical through a leading blank line and a trailing newline", () => {
    // Both edges of the partition in one string: the leading "\n\n" is a span
    // with no sentence, and the trailing "\n" belongs to the span it ends.
    const text = "\n\nAlpha one. Beta two.\n";
    render(
      <DimmedTextarea value={text} onChange={() => {}} aiVersions={[text]} dimmed label="Body" />,
    );
    expect(screen.getByTestId("dim-overlay").textContent).toBe(
      (screen.getByLabelText("Body") as HTMLTextAreaElement).value,
    );
  });

  it("dims every sentence while the text is still the AI's", () => {
    render(<DimmedTextarea value={AI} onChange={() => {}} aiVersions={[AI]} dimmed label="Body" />);
    expect(flags()).toEqual(["true", "true", "true"]);
  });

  it("never dims a blank span, and never spends its flag on one", () => {
    // The partition and the sentence list do not index-align: this text is
    // three spans and two sentences. Zipping the mask on by index would dim the
    // blank line and leave the last sentence undimmed — ["true","true","false"].
    const text = "\n\nAlpha one. Beta two.";
    render(
      <DimmedTextarea value={text} onChange={() => {}} aiVersions={[text]} dimmed label="Body" />,
    );
    expect(flags()).toEqual(["false", "true", "true"]);
  });

  it("un-dims only the sentence a human edited, mid-text", async () => {
    const user = userEvent.setup();
    render(<Harness initial={AI} aiVersions={[AI]} />);
    const textarea = screen.getByLabelText("Body") as HTMLTextAreaElement;
    // Typed at a caret inside "Beta two.", not appended: an editor that only
    // ever tested typing at the end would not notice a surface that no-ops
    // mid-text (design §1).
    await user.type(textarea, "ZZ", { initialSelectionStart: 16, initialSelectionEnd: 16 });

    expect(textarea.value).toBe("Alpha one. Beta ZZtwo.\n\nGamma three.");
    expect(flags()).toEqual(["true", "false", "true"]);
  });

  it("renders a language with no sentence terminator as one span", () => {
    // Thai has no sentence-final punctuation; provenance degrades to a
    // whole-body comparison rather than pretending to a granularity it lacks.
    const thai = "สวัสดีครับ ผมชื่อพูบริค";
    render(
      <DimmedTextarea value={thai} onChange={() => {}} aiVersions={[thai]} dimmed label="Body" />,
    );
    expect(flags()).toEqual(["true"]);
    expect(screen.getByTestId("dim-overlay").textContent).toBe(thai);
  });

  it("renders no overlay when the lens is off", () => {
    render(<DimmedTextarea value={AI} onChange={() => {}} aiVersions={[AI]} label="Body" />);
    expect(screen.queryByTestId("dim-overlay")).toBeNull();
    // ...and the real text is opaque, or the field would be blank.
    expect(screen.getByLabelText("Body")).not.toHaveAttribute("data-dim-input");
  });

  it("stands aside while an IME is composing, so the pre-edit text is visible", () => {
    render(<Harness initial={AI} aiVersions={[AI]} />);
    const textarea = screen.getByLabelText("Body");

    fireEvent.compositionStart(textarea);
    // The overlay cannot mirror pre-edit text — the value has not changed yet —
    // so a transparent textarea would swallow what the user is typing.
    expect(screen.queryByTestId("dim-overlay")).toBeNull();
    expect(textarea).not.toHaveAttribute("data-dim-input");

    fireEvent.compositionEnd(textarea);
    expect(screen.getByTestId("dim-overlay")).toBeInTheDocument();
    expect(textarea).toHaveAttribute("data-dim-input");
  });

  it("hides the overlay from assistive technology and from the pointer", () => {
    render(<DimmedTextarea value={AI} onChange={() => {}} aiVersions={[AI]} dimmed label="Body" />);
    const overlay = screen.getByTestId("dim-overlay");
    expect(overlay).toHaveAttribute("aria-hidden", "true");
    expect(overlay.className).toContain("pointer-events-none");
    // The labelled control is the textarea and only the textarea.
    expect(screen.getByLabelText("Body").tagName).toBe("TEXTAREA");
  });

  it("fades the overlay with the textarea it sits on when the field is disabled", () => {
    render(
      <DimmedTextarea
        value={AI}
        onChange={() => {}}
        aiVersions={[AI]}
        dimmed
        disabled
        label="Body"
      />,
    );
    // The textarea fades via `disabled:opacity-50`; a div cannot match
    // `:disabled`, so the layer above it would otherwise stay fully opaque.
    expect(screen.getByTestId("dim-overlay").className).toContain("opacity-50");
  });

  it("mirrors dir onto both layers rather than leaving the overlay to inherit", () => {
    render(
      <DimmedTextarea
        value={AI}
        onChange={() => {}}
        aiVersions={[AI]}
        dimmed
        dir="rtl"
        label="Body"
      />,
    );
    expect(screen.getByLabelText("Body")).toHaveAttribute("dir", "rtl");
    expect(screen.getByTestId("dim-overlay")).toHaveAttribute("dir", "rtl");
  });

  it("keeps the hard cap and the displayed denominator separate", () => {
    render(
      <DimmedTextarea
        value="x"
        onChange={() => {}}
        aiVersions={[]}
        label="Body"
        maxLength={4096}
        displayLimit={280}
        showCount
      />,
    );
    expect(screen.getByLabelText("Body")).toHaveAttribute("maxlength", "4096");
    expect(screen.getByTestId("char-count")).toHaveTextContent("1 / 280");
  });

  it("shows an over-limit override as over-limit instead of truncating it", () => {
    // The whole point of the two numbers: a 300-character override for X stays
    // editable, and the counter says it is too long rather than the browser
    // silently cutting it (design §6).
    render(
      <DimmedTextarea
        value={"x".repeat(300)}
        onChange={() => {}}
        aiVersions={[]}
        label="Body"
        maxLength={4096}
        displayLimit={280}
        showCount
      />,
    );
    expect(screen.getByTestId("char-count")).toHaveTextContent("300 / 280");
    expect(screen.getByTestId("char-count")).toHaveAttribute("data-over-limit");
  });

  it("renders the counter exactly as Textarea does", () => {
    // Two components, one counter format. Without this the lens-aware field can
    // drift from the plain one and no test in either file would notice.
    const { unmount } = render(
      <DimmedTextarea
        value="hello"
        onChange={() => {}}
        aiVersions={[]}
        label="Body"
        maxLength={280}
        showCount
      />,
    );
    const dimmed = screen.getByTestId("char-count").textContent;
    unmount();

    render(<Textarea label="Body" value="hello" onChange={() => {}} maxLength={280} showCount />);
    expect(screen.getByTestId("char-count").textContent).toBe(dimmed);
  });

  it("describes the textarea by its counter without dropping a caller's own description", () => {
    render(
      <DimmedTextarea
        value="x"
        onChange={() => {}}
        aiVersions={[]}
        label="Body"
        id="b"
        aria-describedby="hint"
        maxLength={280}
        showCount
      />,
    );
    expect(screen.getByLabelText("Body")).toHaveAttribute("aria-describedby", "hint b-count");
  });
});
