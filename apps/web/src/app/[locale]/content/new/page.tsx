"use client";

import { MAX_BODY_LENGTH } from "@pubrick/shared";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, api, errorMessage } from "@/lib/api";
import { channelLabel } from "@/lib/platform";

type Brand = { id: string; name: string };
type Channel = { id: string; platform: string; name: string };
type ContentItem = { id: string };

const FORM_ID = "new-content-form";

export default function NewContentPage() {
  const t = useTranslations("ContentNew");
  const locale = useLocale();
  const router = useRouter();

  const [brands, setBrands] = useState<Brand[] | null>(null);
  const [brandId, setBrandId] = useState("");
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelIds, setChannelIds] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.noActiveOrg) {
        router.replace(`/${locale}/onboarding`);
        return;
      }
      setError(errorMessage(err, t("genericError")));
    },
    [router, locale, t],
  );

  useEffect(() => {
    api<Brand[]>("/api/brands").then(setBrands).catch(handleError);
  }, [handleError]);

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
    </AppShell>
  );
}
