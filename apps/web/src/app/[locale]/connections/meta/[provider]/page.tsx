"use client";

import {
  META_CONNECTION_PROVIDERS,
  type MetaAuthorizationCompleted,
  type MetaConnectionProvider,
  metaAuthorizationCompletedSchema,
  metaAuthorizationCompleteSchema,
  metaPageSelectionSchema,
} from "@pubrick/shared";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api, errorMessage } from "@/lib/api";

type PageChoices = Extract<MetaAuthorizationCompleted, { status: "choose_page" }>;

function MetaCallback({ provider }: { provider: MetaConnectionProvider }) {
  const t = useTranslations("MetaConnections");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const router = useRouter();
  const pending = useRef<Promise<unknown> | null>(null);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<PageChoices | null>(null);
  const [pageId, setPageId] = useState("");
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let active = true;
    if (!pending.current) {
      // Preserve duplicate parameters for oauth4webapi; discard the code from browser history immediately.
      const parameters = window.location.search.slice(1);
      window.history.replaceState(window.history.state, "", window.location.pathname);
      pending.current = Promise.resolve().then(() =>
        api("/api/channels/meta/complete", {
          method: "POST",
          body: JSON.stringify(metaAuthorizationCompleteSchema.parse({ provider, parameters })),
        }),
      );
    }
    pending.current
      .then((value) => {
        if (!active) return;
        const result = metaAuthorizationCompletedSchema.parse(value);
        if (result.status === "connected") {
          router.replace(`/${result.locale}/brands/${result.brandId}#channels`);
        } else {
          if (provider !== "facebook_page") throw new Error("Unexpected Page selection");
          setChoices(result);
          setPageId("");
          setExpired(Date.parse(result.expiresAt) <= Date.now());
        }
      })
      .catch((caught) => {
        if (active) setError(errorMessage(caught, t("genericError"), te));
      });
    return () => {
      active = false;
    };
  }, [provider, router, t, te]);

  useEffect(() => {
    if (!choices) return;
    const remaining = Date.parse(choices.expiresAt) - Date.now();
    if (remaining <= 0) {
      setExpired(true);
      return;
    }
    const timer = setTimeout(() => setExpired(true), remaining);
    return () => clearTimeout(timer);
  }, [choices]);

  async function selectPage() {
    if (!choices || !pageId || expired || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = metaAuthorizationCompletedSchema.parse(
        await api("/api/channels/meta/select-page", {
          method: "POST",
          body: JSON.stringify(
            metaPageSelectionSchema.parse({ requestId: choices.requestId, pageId }),
          ),
        }),
      );
      if (result.status !== "connected") throw new Error("The Page was not connected");
      if (mounted.current) router.replace(`/${result.locale}/brands/${result.brandId}#channels`);
    } catch (caught) {
      // Selection is single-use. A failed verification needs a fresh authorization, never a resend.
      if (mounted.current) {
        setError(errorMessage(caught, t("genericError"), te));
        setExpired(true);
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <AppShell title={t("callbackTitle")}>
      <Card>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : choices ? (
          <>
            <h2 className="font-semibold">{t("choosePage")}</h2>
            <p className="mt-2 text-sm text-fg-secondary">{t("choosePageHelp")}</p>
            <fieldset className="mt-4 space-y-2" disabled={busy || expired}>
              <legend className="sr-only">{t("choosePage")}</legend>
              {choices.pages.map((page) => (
                <label
                  key={page.id}
                  className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md border border-border px-3 py-2"
                >
                  <input
                    type="radio"
                    name="meta-page"
                    value={page.id}
                    checked={pageId === page.id}
                    onChange={() => setPageId(page.id)}
                  />
                  <span className="min-w-0 break-words">{page.name}</span>
                </label>
              ))}
            </fieldset>
            <Button
              className="mt-4 min-h-11"
              disabled={busy || expired || !pageId}
              onClick={selectPage}
            >
              {busy ? t("working") : t("connectPage")}
            </Button>
            {expired && (
              <p role="alert" className="mt-3 text-sm text-danger">
                {t("selectionExpired")}
              </p>
            )}
          </>
        ) : (
          <p role="status" className="text-fg-secondary">
            {t("callbackPending")}
          </p>
        )}
        {(error || expired) && (
          <p className="mt-3 text-sm text-fg-secondary">{t("callbackRecovery")}</p>
        )}
        {(error || choices) && (
          <Link
            className="mt-4 inline-flex min-h-11 items-center text-accent underline"
            href={`/${locale}/brands`}
          >
            {t("backToBrands")}
          </Link>
        )}
      </Card>
    </AppShell>
  );
}

export default function MetaCallbackPage() {
  const { provider } = useParams<{ provider: string }>();
  const t = useTranslations("MetaConnections");
  const locale = useLocale();
  if (!(META_CONNECTION_PROVIDERS as readonly string[]).includes(provider))
    return (
      <AppShell title={t("callbackTitle")}>
        <Card>
          <p role="alert" className="text-danger">
            {t("genericError")}
          </p>
          <Link
            className="mt-4 inline-flex min-h-11 items-center text-accent underline"
            href={`/${locale}/brands`}
          >
            {t("backToBrands")}
          </Link>
        </Card>
      </AppShell>
    );
  // Provider changes remount all pending code/choice state; no previous connection can bleed into another callback.
  return <MetaCallback key={provider} provider={provider as MetaConnectionProvider} />;
}
