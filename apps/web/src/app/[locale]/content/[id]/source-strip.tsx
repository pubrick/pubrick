"use client";

import { useTranslations } from "next-intl";
import { isHttpUrl } from "@/lib/external-url";
import { type RunInput, sourceHost } from "@/lib/runs";

/**
 * WHERE THIS DRAFT CAME FROM, on the draft itself.
 *
 * The receipt already says what a run was asked for, and it is one click away
 * — but the reader deciding whether to publish is on THIS screen, and "these
 * are not your words, they are someone else's article rewritten" is the one
 * fact they cannot reconstruct from the text in front of them. The badge above
 * says a model wrote it; this says what the model was working from.
 *
 * NOTHING AT ALL for a hand-written draft (`input === null`, the ordinary
 * case) and nothing for a run started from a brief: a brief is an instruction
 * the reader gave themselves, it is on the receipt, and repeating it here
 * would put a second copy of the run screen above the editor. The strip exists
 * for the one thing the draft cannot say about itself.
 *
 * A separate component rather than more markup in `page.tsx` because it is the
 * whole of a decision — what a draft is allowed to claim about its origin —
 * and it is tested as one.
 */
export function SourceStrip({ input }: { input: RunInput | null }) {
  /**
   * The RUN's vocabulary, from the namespace that owns it. Every string here
   * is one the receipt already says in four languages; a `Publish.*` copy of
   * them would be two screens calling one thing two names.
   */
  const t = useTranslations("Runs");

  if (input === null || input.kind !== "source") return null;

  /**
   * `example.com`, not the whole address — through `sourceHost`, which is this
   * product's ONE host derivation (the queue strip's, and the one the watched
   * sources gate's SQL is written to agree with). `null` for a stored value
   * that is not a URL, and then there is simply nothing to link.
   */
  const host = sourceHost(input.sourceUrl);

  return (
    <div
      data-testid="source-strip"
      className="mb-4 border-l-2 border-border pl-3 text-sm text-fg-secondary"
    >
      <p>
        <span>{t("pastedLabel")}</span>
        {input.sourceUrl !== null && host !== null && (
          <>
            {" — "}
            {/*
              ATTRIBUTION, and only attribution. Nothing here or on the server
              ever fetched this address, and it never reached a model. It is a
              link at all only because the DTO refuses every scheme but
              http/https; `rel` keeps the opened tab from getting a handle on
              this one.
            */}
            {isHttpUrl(input.sourceUrl) ? (
              <a
                href={input.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="break-all text-accent hover:underline"
              >
                {host}
              </a>
            ) : (
              <span className="break-all">{host}</span>
            )}
          </>
        )}
      </p>
      {input.text === null ? (
        /*
          Not an empty "Brief" block, and never the word `null`: a label with
          nothing under it reads as "the person wrote nothing useful", and this
          line says what actually happened.
        */
        <p className="mt-1 text-fg-tertiary">{t("noBrief")}</p>
      ) : (
        <>
          <p className="mt-2 font-medium text-fg">{t("briefLabel")}</p>
          <p data-testid="source-strip-brief" className="mt-1 whitespace-pre-wrap">
            {input.text}
          </p>
        </>
      )}
      <p className="mt-2 font-medium text-fg">{t("materialLabel")}</p>
      {/*
        Capped and scrollable, exactly as on the receipt: the material can be
        8000 characters, and an uncapped block would push the draft — the thing
        this screen is for — off the bottom of the first screenful.
      */}
      <p
        data-testid="source-strip-material"
        className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap"
      >
        {input.material}
      </p>
    </div>
  );
}
