"use client";

import { type AiCredentialPublic, MAX_BODY_LENGTH, MAX_BRIEF_LENGTH } from "@pubrick/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
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
  // `null` until the first answer: neither Generate nor the "add a key" hint
  // should flash while we still do not know which of the two is true.
  const [credentials, setCredentials] = useState<AiCredentialPublic[] | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
    if (brief.trim() === "") {
      setError(t("briefRequired"));
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
        body: JSON.stringify({ brandId, brief, channelIds: [...channelIds] }),
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
