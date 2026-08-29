"use client";

import { dimSpans, normalizeNewlines } from "@pubrick/shared";
import type { TextareaHTMLAttributes, UIEvent } from "react";
import { useCallback, useId, useMemo, useRef, useState } from "react";

/**
 * A textarea that shows which sentences are still the AI's.
 *
 * It is a real `<textarea>` with a mirrored overlay, not an editor framework
 * (design §1): the browser keeps caret, IME, dead keys, autocorrect, selection
 * handles and undo, and we own only paint. The overlay renders the same
 * characters, dimming the spans that are still verbatim AI text.
 *
 * The whole trick rests on the two layers laying every character in the same
 * place, so:
 *
 *  - both render `MIRRORED_METRICS` — every property that decides where a
 *    glyph lands (design §7);
 *  - the overlay renders `text.slice(start, end)` for a **gapless** partition,
 *    so its `textContent` is character-identical to the textarea's `value`. A
 *    dropped space or newline is a highlight sliding off the words it
 *    describes, and it is the one thing a layout-less jsdom can still prove;
 *  - the text both layers render is `normalizeNewlines(value)`, because a
 *    `<textarea>` strips CR from its API value while a React string keeps it —
 *    so a raw `value` is the one input that can break the identity above from
 *    *outside* the partition. The DTO layer already stores bodies CR-free
 *    (`normalizeNewlines`' docstring in `@pubrick/shared` has the mechanism);
 *    this is the belt for text that arrived by another road — a model's own
 *    output, a row written before that rule existed;
 *  - `dir` is passed to both rather than inherited, so an RTL first character
 *    flips them together.
 *
 * Isolated behind one component on purpose: Chrome 152's `OpaqueRange` is the
 * API that eventually deletes the mirror, and nothing else may depend on how
 * the mirror is built.
 */

/**
 * Everything that decides where a character lands. One string, applied to both
 * layers, because a property that reaches only one of them misaligns the whole
 * paint — and the misalignment is invisible in jsdom, which has no layout.
 *
 * `text-sm` carries font-size *and* line-height; `font-sans` pins the family
 * rather than trusting two different elements to inherit the same one (a
 * `<textarea>` takes the UA's form-control font unless told otherwise).
 *
 * `scrollbar-gutter: stable` is a metric too, and one design §7 does not list:
 * when the textarea overflows, a classic (space-taking) scrollbar narrows its
 * content box and its wrap points move, while the overlay's do not. Reserving
 * the gutter on both keeps the two content boxes the same width whether or not
 * the scrollbar is showing.
 *
 * Exported so a test can assert it REACHES both elements. Comparing the two
 * class strings to each other would be the tautology design §8 rules out —
 * without layout it proves nothing about alignment. Comparing each against the
 * shared constant proves something else, and the higher-consequence thing:
 * that neither layer has quietly stopped receiving it.
 */
export const MIRRORED_METRICS = [
  // `block`, not the UA's inline-block: an inline-level textarea sits on the
  // text baseline, so its wrapper is ~6px taller than the control and the
  // overlay — absolutely positioned to the wrapper — inherits that slack.
  // Measured in Chrome: wrapper 224px, textarea 218px, both layers still
  // starting at the same origin, so it costs no alignment today. It is fixed
  // anyway because it makes the two boxes differ for a reason unrelated to
  // anything in this component, which is how a later scroll or height
  // calculation acquires a 6px error nobody can explain.
  "block box-border min-h-24 w-full border px-3 py-2",
  "font-sans text-sm font-normal tracking-normal normal-case [word-spacing:normal] [tab-size:4]",
  "whitespace-pre-wrap break-words",
  "[scrollbar-gutter:stable]",
].join(" ");

export type DimmedTextareaProps = {
  value: string;
  /** Receives the new text, not the event: the mask is a function of the text. */
  onChange: (value: string) => void;
  /** Every `ai` version body to dim against — all of them, never concatenated. */
  aiVersions: readonly string[];
  /** The lens. Off by default (design §5). */
  dimmed?: boolean;
  label?: string;
  className?: string;
  showCount?: boolean;
  /**
   * The hard cap the browser enforces. Deliberately *not* the same number as
   * `displayLimit`: an existing override longer than the platform limit must
   * stay editable, and a cap below its length would make it permanently
   * unfixable (design §6).
   */
  maxLength?: number;
  /** The counter's denominator — display only, never a cap. */
  displayLimit?: number;
  dir?: "ltr" | "rtl" | "auto";
} & Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "value" | "onChange" | "className" | "dir" | "maxLength"
>;

export function DimmedTextarea({
  value,
  onChange,
  aiVersions,
  dimmed = false,
  label,
  id,
  className,
  showCount,
  maxLength,
  displayLimit,
  disabled,
  dir = "auto",
  "aria-describedby": ariaDescribedBy,
  onScroll,
  onCompositionStart,
  onCompositionEnd,
  ...rest
}: DimmedTextareaProps) {
  const generatedId = useId();
  const textareaId = id ?? generatedId;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  /**
   * An IME's pre-edit text is painted by the browser inside the textarea, and
   * the mirror cannot see it — the value has not changed yet. With the
   * textarea's own text transparent, a composing user would be typing into
   * nothing. The lens steps aside for the duration and the real text paints
   * itself; design §7 lists forced-colors and printing as the conditions where
   * the lens turns itself off, and this is a third.
   */
  const [composing, setComposing] = useState(false);
  const lensOn = dimmed && !composing;

  /**
   * What both layers render, and what the counter counts.
   *
   * A `<textarea>` strips CR from its API value, so handing the element a
   * string containing one guarantees `textarea.value` and the overlay's
   * `textContent` are different lengths — the single failure this component's
   * design says jsdom can prove, arriving from outside the partition. The
   * counter would be wrong by the same amount, and React's `onChange` reads
   * the DOM's already-normalised value, so the first keystroke anywhere in the
   * field would rewrite every CR out of the document with no edit to show for
   * it.
   *
   * Normalised for rendering only; the parent is not called to tell it. A
   * render that fires `onChange` is a render with a side effect, and the
   * canonical form is established at the DTO boundary, where every writer
   * passes (see `normalizeNewlines`). This makes the screen honest about text
   * that reached it another way.
   */
  const text = useMemo(() => normalizeNewlines(value), [value]);

  /**
   * `dimSpans` decides the alignment between the partition and the sentence
   * mask **once**, in shared. Never re-zip `aiSentenceMaskAny` onto
   * `splitSentenceSpans` here: the two lists do not index-align (a leading
   * blank line is a span with no sentence), and zipping dims the blank line
   * while leaving the last sentence undimmed — silently, and plausibly.
   */
  const spans = useMemo(
    () => (lensOn ? dimSpans(text, aiVersions) : null),
    [lensOn, text, aiVersions],
  );

  const denominator = displayLimit ?? maxLength;
  const showCounter = Boolean(showCount) && denominator != null;
  // Strictly over. At exactly the limit the text still fits, and colouring it
  // as a problem would send the author hunting for one that is not there.
  const overLimit = denominator != null && text.length > denominator;
  const counterId = `${textareaId}-count`;
  // Merge with a caller-supplied aria-describedby rather than overwrite it —
  // the counter is one of possibly several descriptions (e.g. a hint too).
  const describedBy =
    [ariaDescribedBy, showCounter ? counterId : null].filter(Boolean).join(" ") || undefined;

  const syncScroll = (event: UIEvent<HTMLTextAreaElement>) => {
    const overlay = overlayRef.current;
    if (overlay) {
      overlay.scrollTop = event.currentTarget.scrollTop;
      overlay.scrollLeft = event.currentTarget.scrollLeft;
    }
    onScroll?.(event);
  };

  // Turning the lens on halfway down a long draft mounts the overlay at the
  // top of a textarea that is not: no scroll event fires for a layer that did
  // not exist yet, so the first sync happens as the overlay attaches. Every
  // later one rides the textarea's `scroll` event, which browsers also emit
  // for scrolling they do themselves.
  //
  // This IS testable in jsdom, and the note that used to sit here saying
  // otherwise ("both sides are always 0") was plausible and wrong. jsdom has no
  // layout, so it never *generates* a scroll offset — but it stores a written
  // `scrollTop` verbatim and reads it back, which is all the propagation these
  // two lines do. A test writes the offset itself and fires the event. What
  // still belongs in a browser (design §8) is whether the synced offset lands
  // the two layers on the same pixel row; that needs wrapping, and wrapping
  // needs layout.
  const attachOverlay = useCallback((overlay: HTMLDivElement | null) => {
    overlayRef.current = overlay;
    const textarea = textareaRef.current;
    if (overlay && textarea) {
      overlay.scrollTop = textarea.scrollTop;
      overlay.scrollLeft = textarea.scrollLeft;
    }
  }, []);

  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={textareaId} className="text-sm font-medium text-fg-secondary">
          {label}
        </label>
      )}
      <div className="relative">
        <textarea
          ref={textareaRef}
          id={textareaId}
          dir={dir}
          disabled={disabled}
          value={text}
          maxLength={maxLength}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
          onScroll={syncScroll}
          onCompositionStart={(event) => {
            setComposing(true);
            onCompositionStart?.(event);
          }}
          onCompositionEnd={(event) => {
            setComposing(false);
            onCompositionEnd?.(event);
          }}
          data-dim-input={lensOn ? "" : undefined}
          className={[
            MIRRORED_METRICS,
            "rounded-control border-border bg-panel text-fg",
            // Explicit, and load-bearing under the lens: a UA derives the
            // placeholder colour from the element's own `color`, so a
            // transparent textarea would have an invisible placeholder.
            "placeholder:text-fg-tertiary",
            "disabled:pointer-events-none disabled:opacity-50",
            lensOn ? "text-transparent caret-fg" : null,
            className,
          ]
            .filter(Boolean)
            .join(" ")}
          {...rest}
        />
        {spans && (
          /*
           * Painted ABOVE the textarea (later in the DOM, both in the same
           * stacking context), not behind it. The textarea paints its own
           * selection background opaquely; with the overlay behind, selecting
           * text would cover the only visible copy of it and the selection
           * would read as an empty blue block. Above, the glyphs sit on top of
           * the highlight. The caret is painted by the textarea underneath,
           * between glyphs, where the overlay puts no ink.
           *
           * `aria-hidden` + `pointer-events-none`: it can never take a click or
           * reach a screen reader, so the textarea stays the only interactive,
           * labelled control.
           */
          <div
            ref={attachOverlay}
            data-testid="dim-overlay"
            data-dim-overlay=""
            aria-hidden="true"
            dir={dir}
            className={[
              MIRRORED_METRICS,
              "pointer-events-none absolute inset-0 select-none overflow-hidden",
              "rounded-control border-transparent text-fg",
              // The textarea fades itself when disabled; the layer painted on
              // top of it has to fade with it or the field reads half-enabled.
              disabled ? "opacity-50" : "",
            ].join(" ")}
          >
            {spans.map((span) => (
              /*
               * Every span carries its flag, blank ones included (they are
               * never AI). The flag comes from `dimSpans`; nothing here
               * re-derives which spans are sentences.
               */
              <span
                key={span.start}
                data-ai={String(span.ai)}
                className={span.ai ? "text-fg-dim" : undefined}
              >
                {text.slice(span.start, span.end)}
              </span>
            ))}
            {/* A trailing newline's empty last line keeps its height from a
                zero-width character in `[data-dim-overlay]::after` — CSS, not a
                text node, so the overlay's textContent stays exactly the
                textarea's value. */}
          </div>
        )}
      </div>
      {showCounter && (
        <span
          id={counterId}
          data-testid="char-count"
          data-over-limit={overLimit ? "" : undefined}
          className={`text-right text-xs ${overLimit ? "text-danger" : "text-fg-tertiary"}`}
        >
          {text.length} / {denominator}
        </span>
      )}
    </div>
  );
}
