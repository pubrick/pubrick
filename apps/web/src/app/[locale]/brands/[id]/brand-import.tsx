"use client";

import {
  type BrandImportSuggestion,
  brandImportApplySchema,
  brandImportRequestSchema,
} from "@pubrick/shared";
import { useTranslations } from "next-intl";
import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Textarea } from "@/components/ui/textarea";
import { api, errorMessage } from "@/lib/api";

type Preview = { sourceUrl: string; suggestion: BrandImportSuggestion };

export function BrandImport({ brandId, onApplied }: { brandId: string; onApplied: () => void }) {
  const t = useTranslations("Brands");
  const te = useTranslations("Errors");
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [consent, setConsent] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [draft, setDraft] = useState<BrandImportSuggestion | null>(null);
  const [selectedTopics, setSelectedTopics] = useState<boolean[]>([]);
  const [topicIds, setTopicIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const close = useCallback(() => {
    if (busyRef.current) return;
    setOpen(false);
    setUrl("");
    setConsent(false);
    setPreview(null);
    setDraft(null);
    setSelectedTopics([]);
    setTopicIds([]);
    setError(null);
  }, []);

  async function fetchPreview(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const body = { url: url.trim(), acceptAiCost: consent };
    const parsed = brandImportRequestSchema.safeParse(body);
    if (!parsed.success) {
      setError(t("importInvalidUrl"));
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const next = await api<Preview>(`/api/brands/${brandId}/import/preview`, {
        method: "POST",
        body: JSON.stringify(parsed.data),
      });
      setPreview(next);
      setDraft(next.suggestion);
      setSelectedTopics(next.suggestion.topics.map(() => true));
      setTopicIds(next.suggestion.topics.map(() => crypto.randomUUID()));
    } catch (reason) {
      setError(errorMessage(reason, t("genericError"), te));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!draft) return;
    setError(null);
    const body = {
      ...draft,
      topics: draft.topics.filter((_, index) => selectedTopics[index]),
    };
    const parsed = brandImportApplySchema.safeParse(body);
    if (!parsed.success) {
      setError(t("importInvalidReview"));
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      await api(`/api/brands/${brandId}/import/apply`, {
        method: "POST",
        body: JSON.stringify(parsed.data),
      });
      busyRef.current = false;
      close();
      onApplied();
    } catch (reason) {
      setError(errorMessage(reason, t("genericError"), te));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function field<K extends keyof Omit<BrandImportSuggestion, "topics">>(
    key: K,
    value: BrandImportSuggestion[K],
  ) {
    setDraft((previous) => (previous ? { ...previous, [key]: value } : previous));
  }

  return (
    <>
      <Button size="sm" variant="secondary" type="button" onClick={() => setOpen(true)}>
        {t("importOpen")}
      </Button>
      <Modal
        open={open}
        onClose={close}
        title={t("importTitle")}
        footer={
          <>
            <Button variant="secondary" type="button" onClick={close} disabled={busy}>
              {t("voiceCancel")}
            </Button>
            <Button
              type="submit"
              form={preview ? "brand-import-review" : "brand-import-preview"}
              disabled={busy || (!preview && !consent)}
            >
              {busy ? t("importWorking") : preview ? t("voiceSave") : t("importPreview")}
            </Button>
          </>
        }
      >
        {error && (
          <p role="alert" className="mb-3 text-sm text-danger">
            {error}
          </p>
        )}
        {preview && draft ? (
          <form id="brand-import-review" onSubmit={save} className="flex flex-col gap-3">
            <p className="text-sm text-fg-secondary">{t("importReviewHint")}</p>
            <p className="break-all text-xs text-fg-tertiary">{preview.sourceUrl}</p>
            <Input
              label={t("nameLabel")}
              value={draft.name}
              maxLength={200}
              required
              onChange={(e) => field("name", e.target.value)}
            />
            <Textarea
              label={t("descriptionLabel")}
              value={draft.description}
              maxLength={2000}
              onChange={(e) => field("description", e.target.value)}
            />
            <Textarea
              label={t("voiceLabel")}
              value={draft.voice}
              maxLength={2000}
              onChange={(e) => field("voice", e.target.value)}
            />
            <Textarea
              label={t("audienceLabel")}
              value={draft.audience}
              maxLength={2000}
              onChange={(e) => field("audience", e.target.value)}
            />
            <Input
              label={t("languageLabel")}
              value={draft.contentLanguage}
              maxLength={10}
              required
              onChange={(e) => field("contentLanguage", e.target.value)}
            />
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium text-fg">{t("importTopics")}</legend>
              {draft.topics.length === 0 && (
                <p className="text-sm text-fg-secondary">{t("importNoTopics")}</p>
              )}
              {draft.topics.map((topic, index) => (
                <div className="flex items-start gap-2" key={topicIds[index]}>
                  <input
                    type="checkbox"
                    className="mt-3"
                    checked={selectedTopics[index] ?? false}
                    aria-label={t("importIncludeTopic", { number: index + 1 })}
                    onChange={(e) =>
                      setSelectedTopics((previous) =>
                        previous.map((selected, i) => (i === index ? e.target.checked : selected)),
                      )
                    }
                  />
                  <Input
                    label={t("importTopicLabel", { number: index + 1 })}
                    value={topic}
                    maxLength={500}
                    onChange={(e) =>
                      setDraft((previous) =>
                        previous
                          ? {
                              ...previous,
                              topics: previous.topics.map((item, i) =>
                                i === index ? e.target.value : item,
                              ),
                            }
                          : previous,
                      )
                    }
                  />
                </div>
              ))}
            </fieldset>
          </form>
        ) : (
          <form id="brand-import-preview" onSubmit={fetchPreview} className="flex flex-col gap-3">
            <p className="text-sm text-fg-secondary">{t("importHint")}</p>
            <Input
              label={t("importUrl")}
              inputMode="url"
              value={url}
              maxLength={2048}
              required
              onChange={(e) => setUrl(e.target.value)}
            />
            <label className="flex items-start gap-2 text-sm text-fg">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                className="mt-1"
              />
              <span>{t("importCostConsent")}</span>
            </label>
          </form>
        )}
      </Modal>
    </>
  );
}
