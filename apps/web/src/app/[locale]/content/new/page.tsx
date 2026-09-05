"use client";

import {
  type AiCredentialPublic,
  MAX_BODY_LENGTH,
  MAX_BRIEF_LENGTH,
  MAX_SOURCE_TEXT_LENGTH,
  runCreateSchema,
} from "@pubrick/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
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

type Brand = { id: string; name: string };
type Channel = { id: string; platform: string; name: string };
type ContentItem = { id: string };

const FORM_ID = "new-content-form";

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
  const [material, setMaterial] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  // `null` until the first answer: neither Generate nor the "add a key" hint
  // should flash while we still do not know which of the two is true.
  const [credentials, setCredentials] = useState<AiCredentialPublic[] | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
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
    api<AiCredentialPublic[]>("/api/ai-credentials")
      .then(setCredentials)
      .catch(() => setCredentials([]));
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
    setChannelIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
    // THE PASTE IS NOT PART OF A MANUAL POST. `contentCreateSchema` has no
    // `material` and no `sourceUrl`, so this path would create a post from the
    // typed body, drop the article the person pasted, and navigate away — with
    // no undo and nothing on screen to say it happened. Refused rather than
    // confirmed: the opposite direction (Generate discarding a typed body) is
    // something a person might actually want, and this never is.
    if (hasMaterial) {
      setError(t("materialBlocksCreate"));
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
            {credentials !== null &&
              (credentials.length > 0 ? (
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
          <Advanced label={t("sourceTitle")} dirty={hasMaterial || hasSourceUrl}>
            <div className="flex flex-col gap-4">
              <Textarea
                id="material"
                label={t("materialLabel")}
                value={material}
                onChange={(e) => setMaterial(e.target.value)}
                placeholder={t("materialPlaceholder")}
                maxLength={MAX_SOURCE_TEXT_LENGTH}
                showCount
                rows={6}
              />
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
                onChange={(e) => setSourceUrl(e.target.value)}
                placeholder={t("sourceUrlPlaceholder")}
                maxLength={2048}
              />
              {/* Both promises in one line, where the fields are: nothing
                  rewrites the paste, and nothing opens the link. */}
              <p className="text-sm text-fg-tertiary">{t("sourceHelp")}</p>
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
