"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { DimmedTextarea } from "@/components/ui/dimmed-textarea";

/** Prewritten, local-only illustration; uses the product's actual editor. */
export function EditorExample() {
  const t = useTranslations("Marketing.example");
  const locale = useLocale();
  const id = useId();
  const proposal = t("proposal");
  const [text, setText] = useState(proposal);
  const [lens, setLens] = useState(false);
  return (
    <section className="public-example" aria-labelledby={`${id}-title`}>
      <div className="public-example-source">
        <p className="public-eyebrow">{t("sourceLabel")}</p>
        <h2 id={`${id}-title`} className="mt-4 font-serif text-2xl leading-tight">
          {t("title")}
        </h2>
        <p className="mt-5 text-sm leading-relaxed text-fg-secondary">{t("source")}</p>
      </div>
      <div className="public-example-draft">
        <p className="mb-4 text-xs font-medium text-fg-secondary">{t("label")}</p>
        <label htmlFor={`${id}-body`} className="mb-3 block text-sm font-semibold">
          {t("draftLabel")}
        </label>
        <DimmedTextarea
          id={`${id}-body`}
          value={text}
          onChange={setText}
          aiVersions={[proposal]}
          dimmed={lens}
          rows={6}
          aria-describedby={`${id}-hint`}
        />
        <p id={`${id}-hint`} className="mt-3 text-xs leading-relaxed text-fg-secondary">
          {t("hint")}
        </p>
        <label className="mt-3 flex min-h-11 cursor-pointer items-center gap-3 text-sm">
          <input
            type="checkbox"
            checked={lens}
            onChange={(event) => setLens(event.target.checked)}
            className="size-4 accent-accent"
          />
          {t("lens")}
        </label>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <p aria-live="polite" className="text-xs text-fg-secondary">
            {t(text === proposal ? "unchanged" : "changed")}
          </p>
          <Button
            variant="ghost"
            className="min-h-11"
            disabled={text === proposal && !lens}
            onClick={() => {
              setText(proposal);
              setLens(false);
            }}
          >
            {t("reset")}
          </Button>
        </div>
        <Link
          href={`/${locale}/product`}
          className="mt-3 inline-flex min-h-11 items-center text-sm font-medium text-accent underline underline-offset-4"
        >
          {t("link")}
        </Link>
      </div>
    </section>
  );
}
