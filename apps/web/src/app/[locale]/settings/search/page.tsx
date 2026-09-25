"use client";

import { type SearchCredentialPublic, searchCredentialUpsertSchema } from "@pubrick/shared";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, api, apiVoid, errorMessage } from "@/lib/api";

const FORM_ID = "search-credential-form";

export default function SearchSettingsPage() {
  const t = useTranslations("SearchSettings");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const [credential, setCredential] = useState<SearchCredentialPublic | null>(null);
  const [folderId, setFolderId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);
  const [noOrganization, setNoOrganization] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api<SearchCredentialPublic>("/api/search-credentials");
      setCredential(result);
      setFolderId(result.folderId ?? "");
      setAccessDenied(false);
      setNoOrganization(false);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.noActiveOrg) {
        setNoOrganization(true);
        setAccessDenied(false);
        setError(null);
        return;
      }
      if (err instanceof ApiError && err.status === 403) {
        setAccessDenied(true);
        setNoOrganization(false);
        setError(null);
        return;
      }
      setError(errorMessage(err, t("genericError"), te));
    }
  }, [t, te]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const request = searchCredentialUpsertSchema.safeParse({ folderId, apiKey });
    if (!request.success) {
      setError(t("invalidCredential"));
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await api<SearchCredentialPublic>("/api/search-credentials", {
        method: "PUT",
        body: JSON.stringify(request.data),
      });
      setCredential(saved);
      setFolderId(saved.folderId ?? "");
      setApiKey("");
      setNotice(t("saved"));
    } catch (err) {
      setError(errorMessage(err, t("genericError"), te));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiVoid("/api/search-credentials", { method: "DELETE" });
      setCredential({ configured: false, folderId: null, updatedAt: null });
      setFolderId("");
      setApiKey("");
      setRemoveOpen(false);
      setNotice(t("removed"));
    } catch (err) {
      setError(errorMessage(err, t("genericError"), te));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AppShell
      title={t("title")}
      primaryAction={
        accessDenied || noOrganization ? undefined : (
          <Button type="submit" form={FORM_ID} disabled={busy || credential === null}>
            {t("save")}
          </Button>
        )
      }
    >
      <div className="flex max-w-2xl flex-col gap-4">
        <Link href={`/${locale}/settings`} className="text-sm text-accent underline">
          {t("back")}
        </Link>
        <Card>
          <h2 className="mb-2 text-base font-semibold text-fg">{t("provider")}</h2>
          <p className="mb-3 text-sm text-fg-secondary">{t("hint")}</p>
          <p className="text-sm text-fg-tertiary">{t("costHint")}</p>
          <a
            href="https://aistudio.yandex.ru/en/docs/search-api/quickstart/"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block text-sm text-accent underline"
          >
            {t("setupGuide")}
          </a>
          {error && (
            <p role="alert" className="mt-3 text-sm text-danger">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="mt-3 text-sm text-fg-secondary">
              {notice}
            </p>
          )}
        </Card>
        {noOrganization ? (
          <Card>
            <p role="alert" className="text-sm text-fg-secondary">
              {te("no_active_organization")}
            </p>
            <Link
              href={`/${locale}/onboarding`}
              className="mt-3 inline-block text-sm text-accent underline"
            >
              {t("onboarding")}
            </Link>
          </Card>
        ) : accessDenied ? (
          <Card>
            <p role="alert" className="text-sm text-fg-secondary">
              {t("managerOnly")}
            </p>
          </Card>
        ) : credential === null ? (
          <Card>
            {error ? (
              <Button variant="secondary" onClick={() => void load()}>
                {t("retry")}
              </Button>
            ) : (
              <Skeleton lines={3} />
            )}
          </Card>
        ) : (
          <Card>
            <p className="mb-4 text-sm text-fg-secondary">
              {credential.configured ? t("configured") : t("notConfigured")}
            </p>
            <form id={FORM_ID} onSubmit={save} className="flex flex-col gap-3">
              <Input
                label={t("folderId")}
                value={folderId}
                onChange={(event) => setFolderId(event.target.value)}
                maxLength={50}
                required
              />
              <Input
                label={t("apiKey")}
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                maxLength={4096}
                required
              />
              <p className="text-sm text-fg-tertiary">{t("keyHint")}</p>
            </form>
            {credential.configured && (
              <Button variant="danger" className="mt-4" onClick={() => setRemoveOpen(true)}>
                {t("remove")}
              </Button>
            )}
          </Card>
        )}
      </div>
      <Modal
        open={removeOpen}
        onClose={() => setRemoveOpen(false)}
        title={t("removeTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setRemoveOpen(false)}>
              {t("cancel")}
            </Button>
            <Button variant="danger" onClick={remove} disabled={busy}>
              {t("remove")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-fg-secondary">{t("removeHint")}</p>
      </Modal>
    </AppShell>
  );
}
