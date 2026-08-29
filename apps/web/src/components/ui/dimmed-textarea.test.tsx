import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { DimmedTextarea, MIRRORED_METRICS } from "./dimmed-textarea";
import { Textarea } from "./textarea";

/**
 * jsdom has no layout engine: every rect is zero and nothing wraps. So these
 * tests pin what jsdom can actually prove — the character stream, the flags,
 * the attributes — and *alignment* (do the two layers land a glyph on the same
 * pixel), forced colors and printing are checked in a browser (design §8).
 *
 * Two things that note used to exclude, wrongly, and that are pinned below:
 *
 * **Scroll sync.** jsdom never generates a scroll offset, but it stores a
 * written `scrollTop` and reads it back — which is the whole of what the sync
 * handler propagates. The test writes the offset itself.
 *
 * **That `MIRRORED_METRICS` reaches both layers.** Comparing the two class
 * strings *to each other* would indeed be a tautology. Comparing each against
 * the shared constant is a different assertion: it cannot prove alignment, and
 * it can prove that a layer has stopped being told about it at all — the
 * highest-consequence regression this component has, and invisible everywhere
 * else in the suite.
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

  /**
   * The corpus that used to be missing, and the one character class that can
   * break the identity from OUTSIDE the partition.
   *
   * A `<textarea>` strips CR from its API value; a React string does not. So
   * an overlay built from the raw prop renders ten characters over a field
   * holding nine, every highlight after the CR slides off the words it
   * describes, and the counter reports a length the field does not have. It is
   * reachable text, not a hypothetical: `POST /api/content` with a CRLF body
   * stored it verbatim until `normalizeNewlines` was added to the DTOs.
   */
  it.each([
    ["CRLF", "One.\r\nTwo."],
    ["a lone CR", "One.\rTwo."],
    ["a trailing CR", "One. Two.\r"],
    ["CR at the very start", "\rOne. Two."],
    ["a run of both", "A.\r\n\rB.\r\nC."],
  ])("stays character-identical through %s, which a textarea would strip", (_name, value) => {
    render(
      <DimmedTextarea value={value} onChange={() => {}} aiVersions={[value]} dimmed label="Body" />,
    );
    const overlay = screen.getByTestId("dim-overlay");
    const textarea = screen.getByLabelText("Body") as HTMLTextAreaElement;
    expect(overlay.textContent).toBe(textarea.value);
    expect(textarea.value).not.toContain("\r");
  });

  it("counts the characters the field actually holds, not the ones a CR added", () => {
    render(
      <DimmedTextarea
        value={"One.\r\nTwo."}
        onChange={() => {}}
        aiVersions={[]}
        label="Body"
        maxLength={280}
        showCount
      />,
    );
    // Ten characters went in; the textarea holds nine. Counting the prop would
    // put a number under the field that no amount of deleting can reach.
    expect((screen.getByLabelText("Body") as HTMLTextAreaElement).value).toHaveLength(9);
    expect(screen.getByTestId("char-count")).toHaveTextContent("9 / 280");
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

  /**
   * ALL versions, per design §3 — the rule the lens has that the gate does not.
   *
   * The gate reads the FIRST `ai` row (it asks "was a human ever involved");
   * the lens dims a sentence still matching ANY row. Today there is one row per
   * level, so a lens that borrowed the gate's rule would look perfect — until
   * 2b's refine verbs write the second, and refined AI text renders as the
   * human's own writing with nothing to notice it. Two versions where the body
   * matches the SECOND is the only fixture that tells the two rules apart.
   */
  it("dims against a later ai version, not only the first", () => {
    const first = "The model's first attempt.";
    const second = "A later AI refinement. And a second sentence.";
    render(
      <DimmedTextarea
        value={second}
        onChange={() => {}}
        aiVersions={[first, second]}
        dimmed
        label="Body"
      />,
    );
    expect(flags()).toEqual(["true", "true"]);
  });

  it("dims each sentence against whichever version it came from", () => {
    // One sentence from each version, which no single-version reference can
    // dim: the OR across versions is what makes both light up.
    const first = "Alpha one.";
    const second = "Beta two.";
    render(
      <DimmedTextarea
        value="Alpha one. Beta two."
        onChange={() => {}}
        aiVersions={[first, second]}
        dimmed
        label="Body"
      />,
    );
    expect(flags()).toEqual(["true", "true"]);
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

  it("gives BOTH layers the mirrored metrics, not just whichever one it renders first", () => {
    render(<DimmedTextarea value={AI} onChange={() => {}} aiVersions={[AI]} dimmed label="Body" />);
    // Not "the two class strings match" — that proves nothing without layout.
    // This is the other question: does the shared string still REACH each
    // layer. Delete it from either className and the mirror stops mirroring,
    // in a way no other test in this file can see.
    expect(screen.getByLabelText("Body").className).toContain(MIRRORED_METRICS);
    expect(screen.getByTestId("dim-overlay").className).toContain(MIRRORED_METRICS);
  });

  /**
   * `text-transparent` and `data-dim-input` are two expressions of one state,
   * and they must turn on and off together.
   *
   * The attribute is what the forced-colors and print rules in `globals.css`
   * key off; the class is what makes the real text invisible so the overlay can
   * paint it. Transparent text with no overlay above it is a completely blank
   * field — so the coupling is asserted in both directions rather than the
   * attribute alone.
   */
  it("makes the textarea transparent exactly when the lens is on", () => {
    const { rerender } = render(
      <DimmedTextarea value={AI} onChange={() => {}} aiVersions={[AI]} label="Body" />,
    );
    const textarea = screen.getByLabelText("Body");
    expect(textarea).not.toHaveAttribute("data-dim-input");
    expect(textarea.className).not.toContain("text-transparent");

    rerender(
      <DimmedTextarea value={AI} onChange={() => {}} aiVersions={[AI]} dimmed label="Body" />,
    );
    expect(textarea).toHaveAttribute("data-dim-input");
    expect(textarea.className).toContain("text-transparent");
  });

  it("keeps the transparent text and the caret colour together", () => {
    // The caret is the only thing the user has left to see where they are:
    // transparent text without an explicit caret colour is an invisible one.
    render(<DimmedTextarea value={AI} onChange={() => {}} aiVersions={[AI]} dimmed label="Body" />);
    expect(screen.getByLabelText("Body").className).toContain("caret-fg");
  });

  it("follows the textarea's scroll offset onto the overlay", () => {
    render(<DimmedTextarea value={AI} onChange={() => {}} aiVersions={[AI]} dimmed label="Body" />);
    const textarea = screen.getByLabelText("Body") as HTMLTextAreaElement;
    const overlay = screen.getByTestId("dim-overlay");
    expect(overlay.scrollTop).toBe(0);

    // jsdom generates no scroll of its own, but it stores what is written and
    // reads it back — which is exactly what the handler propagates.
    textarea.scrollTop = 40;
    textarea.scrollLeft = 12;
    fireEvent.scroll(textarea);

    expect(overlay.scrollTop).toBe(40);
    expect(overlay.scrollLeft).toBe(12);
  });

  it("syncs the offset as the overlay attaches, not only on the next scroll", () => {
    // Turning the lens on halfway down a long draft mounts the overlay at the
    // top of a textarea that is not there any more. No scroll event fires for a
    // layer that did not exist yet, so without the sync on attach the highlight
    // sits a screen above the text until the user scrolls again.
    const { rerender } = render(
      <DimmedTextarea value={AI} onChange={() => {}} aiVersions={[AI]} label="Body" />,
    );
    const textarea = screen.getByLabelText("Body") as HTMLTextAreaElement;
    textarea.scrollTop = 40;

    rerender(
      <DimmedTextarea value={AI} onChange={() => {}} aiVersions={[AI]} dimmed label="Body" />,
    );

    expect(screen.getByTestId("dim-overlay").scrollTop).toBe(40);
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

  it("does not call text that exactly fits over-limit", () => {
    // The boundary, because `>` and `>=` are one character apart and only this
    // input tells them apart: 280 characters for X is a post that sends.
    render(
      <DimmedTextarea
        value={"x".repeat(280)}
        onChange={() => {}}
        aiVersions={[]}
        label="Body"
        maxLength={4096}
        displayLimit={280}
        showCount
      />,
    );
    expect(screen.getByTestId("char-count")).toHaveTextContent("280 / 280");
    expect(screen.getByTestId("char-count")).not.toHaveAttribute("data-over-limit");
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

  /**
   * The two guards that do not live in this component, and so are invisible to
   * every other test here.
   *
   * jsdom applies no stylesheet, so what they DO is a browser check (design
   * §8). That they still EXIST is a string, and worth a string: both are
   * unreferenced from any TypeScript file, which makes them exactly the kind of
   * code a tidy-up deletes with nothing turning red.
   */
  it("keeps the overlay's two CSS guards in the stylesheet", () => {
    // vitest's root is `apps/web`, and a wrong path fails loudly by naming it.
    const css = readFileSync(resolve(process.cwd(), "src/app/globals.css"), { encoding: "utf8" });
    // A trailing newline's empty last line has no character to give it height,
    // and the character must be generated content — a text node would break the
    // textContent identity every test above rests on.
    expect(css).toContain('[data-dim-overlay]::after { content: "\\200B"; }');
    // Forced colors and print: the UA paints the real text opaque over the
    // overlay's copy and the two double, so the lens turns itself off.
    expect(css).toMatch(/@media \(forced-colors: active\), print \{/);
    expect(css).toMatch(/\[data-dim-overlay\]\s*\{\s*display:\s*none;\s*\}/);
    expect(css).toMatch(/\[data-dim-input\]\s*\{\s*color:\s*CanvasText;\s*\}/);
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
