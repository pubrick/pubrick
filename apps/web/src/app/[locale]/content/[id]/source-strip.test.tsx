import { type RunInput, runInputSchema } from "@pubrick/shared";
import { describe, expect, it } from "vitest";
import { render, screen } from "@/test/render";
import en from "../../../../../messages/en.json";
import { SourceStrip } from "./source-strip";

/**
 * Fixtures THROUGH THE COLUMN'S OWN SCHEMA, so a shape this component is
 * handed is a shape the api can actually store. A hand-written literal would
 * keep these tests green through a field rename on the other side of the wire.
 */
function sourceInput(overrides: Partial<Extract<RunInput, { kind: "source" }>> = {}): RunInput {
  return runInputSchema.parse({
    kind: "source",
    text: "Keep it to two paragraphs.",
    sourceUrl: "https://www.example.com/news/story",
    material: "The council voted on Tuesday to fund the new library wing.",
    channelIds: ["11111111-1111-4111-8111-111111111111"],
    ...overrides,
  });
}

const BRIEF_INPUT: RunInput = runInputSchema.parse({
  kind: "brief",
  text: "Write about the vote.",
  channelIds: ["11111111-1111-4111-8111-111111111111"],
});

describe("the source strip on a draft", () => {
  it("says nothing at all about a hand-written draft", () => {
    const { container } = render(<SourceStrip input={null} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("says nothing about a run started from a brief — that is the receipt's job", () => {
    const { container } = render(<SourceStrip input={BRIEF_INPUT} />);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(en.Runs.pastedLabel)).toBeNull();
  });

  it("names the paste and attributes it to the source's host", () => {
    render(<SourceStrip input={sourceInput()} />);

    expect(screen.getByText(en.Runs.pastedLabel)).toBeInTheDocument();
    // The HOST, through `sourceHost` — lowercased before the `www.` strip, the
    // one derivation this product has. The full address is on the receipt.
    const link = screen.getByRole("link", { name: "example.com" });
    expect(link).toHaveAttribute("href", "https://www.example.com/news/story");
    // Attribution, and only attribution: nothing fetches it, and the tab it
    // opens gets no handle on this one.
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("shows the brief the person wrote alongside the material", () => {
    render(<SourceStrip input={sourceInput()} />);

    expect(screen.getByText("Keep it to two paragraphs.")).toBeInTheDocument();
    expect(screen.getByTestId("source-strip-material")).toHaveTextContent(
      "The council voted on Tuesday to fund the new library wing.",
    );
  });

  /**
   * A paste with no brief is the ORDINARY case, and the one an unbranched
   * render draws as a labelled empty block — or, worse, as the word "null".
   */
  it("says no brief was written, rather than drawing an empty brief", () => {
    const { container } = render(<SourceStrip input={sourceInput({ text: null })} />);

    expect(screen.getByText(en.Runs.noBrief)).toBeInTheDocument();
    expect(screen.queryByText(en.Runs.briefLabel)).toBeNull();
    expect(container.textContent).not.toContain("null");
  });

  it("still names the paste when there is no URL to attribute it to", () => {
    render(<SourceStrip input={sourceInput({ sourceUrl: null })} />);

    expect(screen.getByText(en.Runs.pastedLabel)).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });

  /**
   * The DTO refuses any scheme but http/https, so nothing the api returns
   * reaches this branch — but this app does not parse the api's body, and a
   * row written by hand is a row the strip still has to draw.
   */
  it("draws no link for a stored value that is not a URL at all", () => {
    render(<SourceStrip input={{ ...sourceInput(), sourceUrl: "not a url" } as RunInput} />);

    expect(screen.getByText(en.Runs.pastedLabel)).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders in the reader's language, not in the api's English", () => {
    render(<SourceStrip input={sourceInput({ text: null })} />, { locale: "ru" });

    expect(screen.getByText("Черновик по вставленному тексту")).toBeInTheDocument();
    expect(screen.getByText("Без брифа — черновик по источнику.")).toBeInTheDocument();
  });
});
