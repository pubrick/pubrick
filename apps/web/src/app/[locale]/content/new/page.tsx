"use client";

import {
  CONTENT_TYPES,
  COVER_SUPPORTED_PLATFORMS,
  type ContentType,
  contentTypeRequiresMaterial,
  MAX_BODY_LENGTH,
  MAX_BRIEF_LENGTH,
  MAX_SOURCE_TEXT_LENGTH,
  MAX_SOURCE_URL_LENGTH,
  runCreateSchema,
  type SourceExtractionResponse,
  seoKeywordsSchema,
  sourceExtractionRequestSchema,
  supportsInlineImages,
} from "@pubrick/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Advanced } from "@/components/ui/advanced";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, api, errorMessage } from "@/lib/api";
import { channelLabel } from "@/lib/platform";
import type { Run } from "@/lib/runs";
import {
  importTranscript,
  MAX_TRANSCRIPT_FILE_BYTES,
  TranscriptImportError,
} from "@/lib/transcript-import";

type Brand = { id: string; name: string };
type Channel = { id: string; platform: string; name: string };
type ContentItem = { id: string };
type SourcePreview = SourceExtractionResponse & { origin: "article" | "video" | "transcript" };
type AiAvailability = { configured: boolean; googleConfigured: boolean };

const FORM_ID = "new-content-form";
const SOURCE_HELP_ID = "source-help";

export default function NewContentPage() {
  const t = useTranslations("ContentNew");
  // See the queue screen: the api's refusal codes are read from here, which is
  // what puts "this brand has no channels" and the run cap in four languages.
  const te = useTranslations("Errors");
  const locale = useLocale();
  const router = useRouter();

  const [brands, setBrands] = useState<Brand[] | null>(null);
  const [brandId, setBrandId] = useState("");
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelIds, setChannelIds] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [brief, setBrief] = useState("");
  const [contentType, setContentType] = useState<ContentType>("social_post");
  const [generateCover, setGenerateCover] = useState(false);
  const [generateInlineImages, setGenerateInlineImages] = useState(false);
  const [useEditorialFeedback, setUseEditorialFeedback] = useState(false);
  const [seoKeywordsText, setSeoKeywordsText] = useState("");
  const [seoOptionsOpen, setSeoOptionsOpen] = useState(false);
  const [material, setMaterial] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourcePreview, setSourcePreview] = useState<SourcePreview | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [fetchingSource, setFetchingSource] = useState(false);
  const [readingTranscript, setReadingTranscript] = useState(false);
  const sourceRequestId = useRef(0);
  const transcriptRequestId = useRef(0);
  // `null` until the first answer: neither Generate nor the "add a key" hint
  // should flash while we still do not know which of the two is true.
  const [aiAvailability, setAiAvailability] = useState<AiAvailability | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  /**
   * Whether the Source disclosure is open — held HERE because the screen's
   * primary action has to be able to open it.
   *
   * A refusal may only name something the reader can see (constitution). This
   * screen's refusal names the Source section over material that section is
   * shut on, and the only visible trace of that material is a six-pixel dot
   * that is `aria-hidden` — so a person who collapsed it is told a box they
   * cannot see is in their way. The reader still owns the control: `onOpenChange`
   * writes their own toggles back, so nothing traps it open.
   */
  const [sourceOpen, setSourceOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  /**
   * "IS THERE ANYTHING HERE" — asked once, read everywhere.
   *
   * Five places on this path decide whether a field counts as present: the
   * request body's three spreads, the disclosure's dirty dot, the primary
   * action's refusal, `runCreateSchema`'s refine and the repository's writer.
   * The last two live in `@pubrick/shared` and `apps/api` and are trimmed
   * (`runs.ts`, `RunsRepository.create`); these are trimmed here, once, for the
   * reason the refine's own comment gives — two predicates that disagree about
   * whitespace is how a single pasted space lights the dot and makes "Create
   * post" refuse over material the request then omits.
   */
  const hasBrief = brief.trim() !== "";
  const hasMaterial = material.trim() !== "";
  const hasSourceUrl = sourceUrl.trim() !== "";
  const hasSeoKeywords = seoKeywordsText.trim() !== "";
  const seoKeywords = seoKeywordsText
    .split(/\r?\n/)
    .map((term) => term.trim())
    .filter(Boolean);

  /**
   * "IS GENERATE ON THIS SCREEN" — the condition that RENDERS the button, read
   * again by the refusal that names it.
   *
   * A refusal may only name a control the person can see, and this one is the
   * screen's own answer to "what do I do with what I pasted". Without a
   * credential the button is not rendered at all (`aiNotConfigured` and a link
   * to Settings take its place), so the sentence has to point at Settings
   * instead. One expression for both, or the copy starts describing a screen
   * that is not there — which is what it did while availability was read only
   * at the render site.
   */
  const canGenerate = aiAvailability?.configured === true;
  const hasGoogleKey = aiAvailability?.googleConfigured === true;
  const inlineImageTypeSupported = supportsInlineImages(contentType);
  const coverChannelsSupported = [...channelIds].every((id) =>
    (COVER_SUPPORTED_PLATFORMS as readonly string[]).includes(
      channels.find((channel) => channel.id === id)?.platform ?? "",
    ),
  );

  const handleError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.noActiveOrg) {
        router.replace(`/${locale}/onboarding`);
        return;
      }
      setError(errorMessage(err, t("genericError"), te));
    },
    [router, locale, t, te],
  );

  useEffect(() => {
    api<Brand[]>("/api/brands").then(setBrands).catch(handleError);
  }, [handleError]);

  // Whether this org can generate at all. A failure answers "no": the empty
  // state that teaches ("add a key in Settings") is a better wrong answer than
  // a Generate button that starts a run the API will refuse — and it is the
  // same thing the user has to do if the failure was real.
  useEffect(() => {
    api<AiAvailability>("/api/ai-credentials/availability")
      .then(setAiAvailability)
      .catch(() => setAiAvailability({ configured: false, googleConfigured: false }));
  }, []);

  useEffect(() => {
    if (!brandId) {
      setChannels([]);
      setChannelIds(new Set());
      return;
    }
    api<Channel[]>(`/api/channels?brandId=${brandId}`)
      .then((cs) => {
        setChannels(cs);
        setChannelIds(new Set());
      })
      .catch(handleError);
  }, [brandId, handleError]);

  function toggleChannel(id: string) {
    const added = !channelIds.has(id);
    if (
      added &&
      !(COVER_SUPPORTED_PLATFORMS as readonly string[]).includes(
        channels.find((channel) => channel.id === id)?.platform ?? "",
      )
    ) {
      setGenerateCover(false);
    }
    setChannelIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function fetchSource() {
    setSourceError(null);
    if (!brandId) {
      setSourceError(t("noBrandSelected"));
      return;
    }
    const parsed = sourceExtractionRequestSchema.safeParse({ url: sourceUrl });
    if (!parsed.success) {
      setSourceError(t("sourceUrlNotHttp"));
      return;
    }
    transcriptRequestId.current += 1;
    setReadingTranscript(false);
    const requestId = ++sourceRequestId.current;
    setSourcePreview(null);
    setFetchingSource(true);
    try {
      const preview = await api<SourceExtractionResponse>("/api/source-extraction", {
        method: "POST",
        body: JSON.stringify({ ...parsed.data, brandId }),
      });
      if (requestId === sourceRequestId.current) {
        setSourcePreview({ ...preview, origin: preview.kind === "video" ? "video" : "article" });
      }
    } catch (err) {
      if (err instanceof ApiError && err.noActiveOrg) {
        router.replace(`/${locale}/onboarding`);
        return;
      }
      if (requestId === sourceRequestId.current) {
        setSourceError(errorMessage(err, t("genericError"), te));
      }
    } finally {
      if (requestId === sourceRequestId.current) setFetchingSource(false);
    }
  }

  async function selectTranscript(file: File) {
    sourceRequestId.current += 1;
    setFetchingSource(false);
    const requestId = ++transcriptRequestId.current;
    setSourcePreview(null);
    setSourceError(null);
    if (file.size > MAX_TRANSCRIPT_FILE_BYTES) {
      setSourceError(t("transcriptTooLarge"));
      return;
    }
    setReadingTranscript(true);
    try {
      const preview = await importTranscript(file.name, await file.text());
      if (requestId === transcriptRequestId.current) {
        setSourcePreview({ ...preview, origin: "transcript" });
      }
    } catch (err) {
      if (requestId === transcriptRequestId.current) {
        setSourceError(
          err instanceof TranscriptImportError
            ? t(err.code === "empty" ? "transcriptEmpty" : "transcriptInvalid")
            : t("transcriptReadFailed"),
        );
      }
    } finally {
      if (requestId === transcriptRequestId.current) setReadingTranscript(false);
    }
  }

  // Shared by the form's own submit (Enter in a field) and the AppShell
  // header's primary-action button, which lives outside the <form> element
  // (constitution: submit is the top-right primary action, not an in-flow
  // button) but is wired back to it via `form={FORM_ID}` — a real
  // type="submit" button associated with the form by id, so native
  // constraint validation (the required Select/Textarea below) still runs
  // before onFormSubmit fires, exactly as if the button sat inside the form.
  async function createContent() {
    setError(null);
    if (hasSeoKeywords) {
      setError(t("seoKeywordsCreate"));
      setSeoOptionsOpen(true);
      return;
    }
    // THE SOURCE SECTION IS NOT PART OF A MANUAL POST. `contentCreateSchema`
    // has no `material` and no `sourceUrl`, so this path would create a post
    // from the typed body, drop BOTH of the things the person put in that
    // section, and navigate away — with no undo and nothing on screen to say it
    // happened. Refused rather than confirmed: the opposite direction (Generate
    // discarding a typed body) is something a person might actually want, and
    // this never is.
    //
    // The condition is `Advanced`'s own `dirty` expression, character for
    // character (see the disclosure below). An unaccepted transcript preview
    // has no URL or material yet, and an in-flight file read has no preview
    // yet, but both are work the primary action must not silently discard.
    if (hasMaterial || hasSourceUrl || sourcePreview !== null || readingTranscript) {
      setError(t(canGenerate ? "sourceBlocksCreate" : "sourceBlocksCreateNoAi"));
      // ...and put what the sentence is about on screen beside it.
      setSourceOpen(true);
      return;
    }
    if (channelIds.size === 0) {
      setError(t("noChannelsSelected"));
      return;
    }
    setSubmitting(true);
    try {
      const created = await api<ContentItem>("/api/content", {
        method: "POST",
        body: JSON.stringify({
          brandId,
          title: title.trim() === "" ? undefined : title,
          body,
          channelIds: [...channelIds],
        }),
      });
      router.push(`/${locale}/content/${created.id}`);
    } catch (err) {
      handleError(err);
    } finally {
      setSubmitting(false);
    }
  }

  function onFormSubmit(e: React.FormEvent) {
    e.preventDefault();
    void createContent();
  }

  /**
   * Generate is NOT a second way to fill this form.
   *
   * It throws the typed draft away and starts a run that lands a DIFFERENT
   * content item minutes later, so a non-empty body is confirmed first — the
   * text is not saved anywhere, and there is no undo. Everything else it
   * enforces is what "Create post" enforces, inline and in the same words:
   * without them the API answers 400/404 with a sentence about brands and
   * channels that the person looking at this form cannot act on.
   */
  function onGenerate() {
    setError(null);
    if (!brandId) {
      setError(t("noBrandSelected"));
      return;
    }
    if (channelIds.size === 0) {
      setError(t("noChannelsSelected"));
      return;
    }
    if (generateCover && !coverChannelsSupported) {
      setError(t("generateCoverUnsupported"));
      return;
    }
    if (generateInlineImages && !inlineImageTypeSupported) {
      setError(t("generateInlineImagesUnsupported"));
      return;
    }
    if (hasSeoKeywords && !seoKeywordsSchema.safeParse(seoKeywords).success) {
      setError(t("seoKeywordsInvalid"));
      setSeoOptionsOpen(true);
      return;
    }
    if (readingTranscript) {
      setError(t("transcriptReadInProgress"));
      setSourceOpen(true);
      return;
    }
    if (sourcePreview) {
      setError(t("sourcePreviewNeedsUse"));
      setSourceOpen(true);
      return;
    }
    if (contentTypeRequiresMaterial(contentType) && !hasMaterial) {
      setError(t(contentType === "case_study" ? "caseStudyNeedsMaterial" : "repostNeedsMaterial"));
      setSourceOpen(true);
      return;
    }
    // The refine's own rule, in the refine's own words: a run needs something
    // to work from, and either of the two will do (`runCreateSchema`).
    if (!hasBrief && !hasMaterial) {
      setError(t("briefOrMaterialRequired"));
      return;
    }
    // A URL with no material is attribution for nothing. The repository drops
    // it (a source run needs material), and a silent drop on the screen where
    // the person typed it is the defect this refusal exists to prevent.
    if (hasSourceUrl && !hasMaterial) {
      setError(t("sourceUrlNeedsMaterial"));
      return;
    }
    // The scheme check is the API's own member, not a second copy of it: this
    // value is about to be sent as `runCreateSchema.sourceUrl`, so that is what
    // judges it. `z.url()` alone constrains no scheme — `javascript:` and
    // `mailto:` both parse — and the member carries `{ protocol: /^https?$/ }`
    // because the value is rendered as an `<a href>` on two screens.
    if (hasSourceUrl && !runCreateSchema.shape.sourceUrl.safeParse(sourceUrl).success) {
      setError(t("sourceUrlNotHttp"));
      return;
    }
    if (body.trim() !== "") {
      setConfirmDiscard(true);
      return;
    }
    void startRun();
  }

  async function startRun() {
    setConfirmDiscard(false);
    setGenerating(true);
    try {
      const run = await api<Run>("/api/runs", {
        method: "POST",
        // Each field is sent only when there is one. `brief` used to go out
        // unconditionally from a `""` default, which after the DTO became a
        // union meant every paste-only run posted `brief: ""` — a value the
        // schema treats as absent and a lie about what the person did.
        //
        // The values themselves go UNTRIMMED: the trim decides presence, it
        // does not silently edit what someone pasted.
        body: JSON.stringify({
          brandId,
          channelIds: [...channelIds],
          ...(contentType !== "social_post" && { contentType }),
          ...(generateCover && { generateCover: true }),
          ...(generateInlineImages && { generateInlineImages: true }),
          ...(useEditorialFeedback && { useEditorialFeedback: true }),
          ...(hasSeoKeywords && { seoKeywords }),
          ...(hasBrief && { brief }),
          ...(hasMaterial && { material }),
          ...(hasSourceUrl && { sourceUrl }),
        }),
      });
      router.push(`/${locale}/content/runs/${run.id}`);
    } catch (err) {
      handleError(err);
    } finally {
      setGenerating(false);
    }
  }

  return (
    <AppShell
      title={t("title")}
      primaryAction={
        <Button type="submit" form={FORM_ID} disabled={submitting}>
          {t("submit")}
        </Button>
      }
    >
      {error && (
        <p role="alert" className="mb-4 text-sm text-danger">
          {error}
        </p>
      )}

      <Card className="max-w-2xl">
        <form id={FORM_ID} onSubmit={onFormSubmit} className="flex flex-col gap-5">
          <Select
            id="brand"
            label={t("brand")}
            value={brandId}
            onChange={(e) => setBrandId(e.target.value)}
            required
          >
            <option value="">{t("selectBrand")}</option>
            {(brands ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>

          <div>
            <p className="mb-2 text-sm font-medium text-fg-secondary">{t("channels")}</p>
            {!brandId && <p className="text-sm text-fg-tertiary">{t("selectBrandFirst")}</p>}
            {brandId && channels.length === 0 && (
              <p className="text-sm text-fg-tertiary">{t("noChannels")}</p>
            )}
            {channels.length > 0 && (
              <ul className="flex flex-col divide-y divide-border-soft overflow-hidden rounded-control border border-border">
                {channels.map((c) => (
                  <li key={c.id} className="px-3 py-2">
                    <label className="flex items-center gap-2.5 text-sm text-fg">
                      <input
                        type="checkbox"
                        checked={channelIds.has(c.id)}
                        onChange={() => toggleChannel(c.id)}
                        className="h-4 w-4 rounded border-border text-accent"
                      />
                      {channelLabel(c.platform, c.name)}
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <Input
            id="title"
            label={t("titleLabel")}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t("titlePlaceholder")}
            maxLength={300}
          />

          {/*
            The generation entry point. One primary action on this screen stays
            "Create post" (top-right, in the header); Generate is secondary and
            sits with the field it reads. With no AI key configured it is absent
            entirely, replaced by a line that says what to do — not a disabled
            control that explains nothing.
          */}
          <div className="flex flex-col gap-2">
            <Textarea
              id="brief"
              label={t("briefLabel")}
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder={t("briefPlaceholder")}
              maxLength={MAX_BRIEF_LENGTH}
              showCount
              rows={3}
            />
            {canGenerate && (
              <Select
                id="contentType"
                label={t("contentTypeLabel")}
                value={contentType}
                onChange={(event) => {
                  const selected = event.target.value as ContentType;
                  setContentType(selected);
                  if (!supportsInlineImages(selected)) setGenerateInlineImages(false);
                  if (selected !== "expert_article") setSeoKeywordsText("");
                  if (contentTypeRequiresMaterial(selected)) setSourceOpen(true);
                }}
                className="min-h-11"
              >
                {CONTENT_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {t(`contentType.${type}`)}
                  </option>
                ))}
              </Select>
            )}
            {canGenerate && contentType === "expert_article" && (
              <Advanced
                label={t("seoOptions")}
                dirty={hasSeoKeywords}
                open={seoOptionsOpen}
                onOpenChange={setSeoOptionsOpen}
              >
                <Textarea
                  id="seoKeywords"
                  label={t("seoKeywordsLabel")}
                  value={seoKeywordsText}
                  onChange={(event) => setSeoKeywordsText(event.target.value)}
                  placeholder={t("seoKeywordsPlaceholder")}
                  rows={3}
                  aria-describedby="seo-keywords-hint"
                />
                <p id="seo-keywords-hint" className="mt-2 text-sm text-fg-tertiary">
                  {t("seoKeywordsHint")}
                </p>
              </Advanced>
            )}
            {canGenerate && (
              <div className="rounded-control border border-border px-3 py-3">
                <label className="flex items-start gap-3 text-sm text-fg">
                  <input
                    type="checkbox"
                    checked={useEditorialFeedback}
                    onChange={(event) => setUseEditorialFeedback(event.target.checked)}
                    aria-describedby="editorial-feedback-hint"
                    className="mt-0.5 h-5 w-5 rounded border-border text-accent"
                  />
                  <span>{t("useEditorialFeedback")}</span>
                </label>
                <p id="editorial-feedback-hint" className="mt-1 pl-8 text-sm text-fg-tertiary">
                  {t("useEditorialFeedbackHint")}
                </p>
              </div>
            )}
            {canGenerate && (
              <div className="rounded-control border border-border px-3 py-3">
                <label className="flex items-start gap-3 text-sm text-fg">
                  <input
                    type="checkbox"
                    checked={generateInlineImages}
                    onChange={(event) => setGenerateInlineImages(event.target.checked)}
                    disabled={!hasGoogleKey || !inlineImageTypeSupported}
                    aria-describedby="inline-images-hint"
                    className="mt-0.5 h-5 w-5 rounded border-border text-accent"
                  />
                  <span>{t("generateInlineImages")}</span>
                </label>
                <p id="inline-images-hint" className="mt-1 pl-8 text-sm text-fg-tertiary">
                  {t("generateInlineImagesHint")}
                </p>
                {!hasGoogleKey && (
                  <p className="mt-1 pl-8 text-sm text-fg-tertiary">
                    {t("generateInlineImagesNeedsGoogle")}
                  </p>
                )}
                {!inlineImageTypeSupported && (
                  <p className="mt-1 pl-8 text-sm text-fg-tertiary">
                    {t("generateInlineImagesUnsupported")}
                  </p>
                )}
              </div>
            )}
            {canGenerate && (
              <div className="rounded-control border border-border px-3 py-3">
                <label className="flex items-start gap-3 text-sm text-fg">
                  <input
                    type="checkbox"
                    checked={generateCover}
                    onChange={(event) => setGenerateCover(event.target.checked)}
                    disabled={!hasGoogleKey || !coverChannelsSupported}
                    className="mt-0.5 h-5 w-5 rounded border-border text-accent"
                  />
                  <span>{t("generateCover")}</span>
                </label>
                <p className="mt-1 pl-8 text-sm text-fg-tertiary">{t("generateCoverHint")}</p>
                {!hasGoogleKey && (
                  <p className="mt-1 pl-8 text-sm text-fg-tertiary">
                    {t("generateCoverNeedsGoogle")}
                  </p>
                )}
                {!coverChannelsSupported && (
                  <p className="mt-1 pl-8 text-sm text-fg-tertiary">
                    {t("generateCoverUnsupported")}
                  </p>
                )}
              </div>
            )}
            {aiAvailability !== null &&
              (canGenerate ? (
                <div>
                  <Button variant="secondary" onClick={onGenerate} disabled={generating}>
                    {t("generate")}
                  </Button>
                </div>
              ) : (
                <p className="text-sm text-fg-tertiary">
                  {t("aiNotConfigured")}{" "}
                  <Link href={`/${locale}/settings`} className="text-accent hover:underline">
                    {t("aiSettingsLink")}
                  </Link>
                </p>
              ))}
          </div>

          {/*
            Constitution rule 2: the paste lives behind THE shared disclosure,
            never loose on the form and never behind a bespoke "show more". The
            dot matters more here than anywhere else it is used — this section
            can hold 8 000 characters while collapsed, and the screen's primary
            action refuses over them.
          */}
          <Advanced
            label={t("sourceTitle")}
            dirty={hasMaterial || hasSourceUrl || sourcePreview !== null || readingTranscript}
            open={sourceOpen}
            onOpenChange={setSourceOpen}
          >
            <div className="flex flex-col gap-4">
              {/*
                `inputMode` and NOT `type="url"`, which is what this plan asked
                for and is the one instruction in it that does not survive
                contact with `Advanced`. A `type="url"` control holding an
                unparseable value — "example.com", the most natural thing to
                type — is invalid AND unfocusable while this section is
                collapsed, so the browser refuses the form's submit and reports
                nothing at all: "Create post" becomes a dead button with no
                sentence anywhere, which is precisely what the constitution
                says a primary action may never be. (Reproduced in jsdom; the
                regression is pinned in this screen's tests.) The URL keyboard
                is kept, and the scheme rule stays where §2.7 puts it — on
                `runCreateSchema.sourceUrl`, refused inline below in the
                reader's own language rather than by a browser bubble in the
                browser's.
              */}
              <Input
                id="sourceUrl"
                inputMode="url"
                label={t("sourceUrlLabel")}
                value={sourceUrl}
                onChange={(e) => {
                  sourceRequestId.current += 1;
                  setFetchingSource(false);
                  setSourceUrl(e.target.value);
                  setSourcePreview((preview) =>
                    preview?.origin === "transcript" ? preview : null,
                  );
                  setSourceError(null);
                }}
                placeholder={t("sourceUrlPlaceholder")}
                maxLength={MAX_SOURCE_URL_LENGTH}
                aria-describedby={SOURCE_HELP_ID}
              />
              <div>
                <Button
                  variant="secondary"
                  className="min-h-11"
                  onClick={() => void fetchSource()}
                  disabled={fetchingSource}
                >
                  {t(fetchingSource ? "fetchingSource" : "fetchSource")}
                </Button>
              </div>
              <div>
                <label
                  htmlFor="transcriptFile"
                  className="mb-1.5 block text-sm font-medium text-fg"
                >
                  {t("transcriptLabel")}
                </label>
                <input
                  id="transcriptFile"
                  type="file"
                  accept=".srt,.vtt,.txt,text/plain,text/vtt,application/x-subrip"
                  disabled={readingTranscript}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    // Allow choosing the same corrected file after an error.
                    event.target.value = "";
                    if (file) void selectTranscript(file);
                  }}
                  aria-describedby="transcript-help"
                  className="block min-h-11 w-full rounded-control border border-border px-3 py-2 text-sm text-fg file:mr-3 file:rounded-control file:border-0 file:bg-bg-sunken file:px-3 file:py-1 file:text-fg-secondary"
                />
                <p id="transcript-help" className="mt-1 text-sm text-fg-tertiary">
                  {t("transcriptHelp")}
                </p>
                {readingTranscript && (
                  <p role="status" className="mt-1 text-sm text-fg-secondary">
                    {t("readingTranscript")}
                  </p>
                )}
              </div>
              {sourceError && (
                <p role="alert" className="text-sm text-danger">
                  {sourceError}
                </p>
              )}
              {sourcePreview && (
                <div
                  className="rounded-control border border-border bg-bg-sunken p-4"
                  aria-live="polite"
                >
                  <p className="text-sm font-semibold text-fg">
                    {t(
                      sourcePreview.origin === "transcript" || sourcePreview.origin === "video"
                        ? "transcriptPreviewTitle"
                        : "sourcePreviewTitle",
                    )}
                  </p>
                  {sourcePreview.title && (
                    <p className="mt-1 text-sm text-fg-secondary">{sourcePreview.title}</p>
                  )}
                  <div className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap text-sm text-fg-secondary">
                    {sourcePreview.material}
                  </div>
                  {sourcePreview.truncated && (
                    <p className="mt-2 text-sm text-fg-tertiary">
                      {t("sourcePreviewTruncated", { limit: MAX_SOURCE_TEXT_LENGTH })}
                    </p>
                  )}
                  <Button
                    variant="secondary"
                    className="mt-3 min-h-11"
                    onClick={() => {
                      setMaterial(sourcePreview.material);
                      setSourcePreview(null);
                    }}
                  >
                    {t(hasMaterial ? "replaceSourceText" : "useSourceText")}
                  </Button>
                  <Button
                    variant="ghost"
                    className="mt-3 ml-2 min-h-11"
                    onClick={() => setSourcePreview(null)}
                  >
                    {t("dismissSourcePreview")}
                  </Button>
                </div>
              )}
              <Textarea
                id="material"
                label={t("materialLabel")}
                value={material}
                onChange={(e) => setMaterial(e.target.value)}
                placeholder={t("materialPlaceholder")}
                maxLength={MAX_SOURCE_TEXT_LENGTH}
                showCount
                aria-describedby={SOURCE_HELP_ID}
                rows={6}
              />
              <p id={SOURCE_HELP_ID} className="text-sm text-fg-tertiary">
                {t("sourceHelp")}
              </p>
            </div>
          </Advanced>

          <Textarea
            id="body"
            label={t("body")}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t("bodyPlaceholder")}
            maxLength={MAX_BODY_LENGTH}
            showCount
            rows={10}
            required
          />
        </form>
      </Card>

      <Modal
        open={confirmDiscard}
        onClose={() => setConfirmDiscard(false)}
        title={t("discardTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDiscard(false)}>
              {t("discardCancel")}
            </Button>
            <Button variant="danger" onClick={startRun} disabled={generating}>
              {t("discardConfirm")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-fg-secondary">{t("discardBody")}</p>
      </Modal>
    </AppShell>
  );
}
