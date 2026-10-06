"use client";

import {
  linkedinAuthorizationCompletedSchema,
  linkedinAuthorizationCompleteSchema,
} from "@pubrick/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { api, errorMessage } from "@/lib/api";

export default function LinkedInCallbackPage() {
  const t = useTranslations("LinkedIn");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const router = useRouter();
  const pending = useRef<Promise<unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    if (!pending.current) {
      // Keep duplicates for the OAuth library, then remove the consumed code from local history.
      const parameters = window.location.search.slice(1);
      window.history.replaceState(window.history.state, "", window.location.pathname);
      pending.current = Promise.resolve().then(() =>
        api("/api/channels/linkedin/complete", {
          method: "POST",
          body: JSON.stringify(linkedinAuthorizationCompleteSchema.parse({ parameters })),
        }),
      );
    }
    pending.current
      .then((value) => {
        if (!active) return;
        const result = linkedinAuthorizationCompletedSchema.parse(value);
        router.replace(`/${result.locale}/brands/${result.brandId}#channels`);
      })
      .catch((caught) => {
        if (active) setError(errorMessage(caught, t("genericError"), te));
      });
    return () => {
      active = false;
    };
  }, [router, t, te]);
  return (
    <AppShell title={t("callbackTitle")}>
      <Card>
        {error ? (
          <>
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
            <p className="mt-3 text-sm text-fg-secondary">{t("callbackRecovery")}</p>
            <Link
              className="mt-4 inline-flex min-h-11 items-center text-accent underline"
              href={`/${locale}/brands`}
            >
              {t("backToBrands")}
            </Link>
          </>
        ) : (
          <p role="status" className="text-fg-secondary">
            {t("callbackPending")}
          </p>
        )}
      </Card>
    </AppShell>
  );
}
