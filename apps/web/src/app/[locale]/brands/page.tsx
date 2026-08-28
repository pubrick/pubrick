"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { IconBrands, IconChevronRight } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { ApiError, api, errorMessage } from "@/lib/api";

type Brand = { id: string; name: string; contentLanguage: string };

// Explicit id (not Input's auto-generated one) so the empty-state action
// below can find and focus this field without lifting a ref just for that.
const NAME_INPUT_ID = "brand-name";

// The create form's id — the AppShell header's primary-action button lives
// outside the <form> element (constitution: submit is top-right in the
// toolbar, not at the bottom of the form) and is wired back to it via
// `form={FORM_ID}` on a real type="submit" button.
const FORM_ID = "brand-create-form";

export default function BrandsPage() {
  const t = useTranslations("Brands");
  const locale = useLocale();
  const router = useRouter();
  const [brands, setBrands] = useState<Brand[] | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  // A 403 from ActiveOrgGuard means the account has no organization yet — that is an
  // onboarding step, not an error to show the user.
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

  const load = useCallback(() => {
    api<Brand[]>("/api/brands").then(setBrands).catch(handleError);
  }, [handleError]);

  useEffect(load, [load]);

  async function createBrand(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api("/api/brands", { method: "POST", body: JSON.stringify({ name }) });
      setName("");
      load();
    } catch (err) {
      handleError(err);
    }
  }

  // The create form stays visible regardless of whether the list is empty —
  // it is not nested inside the empty-state branch below. A brands-list test
  // exercises the failing-creation path against a served empty array and
  // still expects the name field to be on screen.
  const isEmpty = brands !== null && brands.length === 0;

  return (
    <AppShell
      title={t("title")}
      primaryAction={
        <Button type="submit" form={FORM_ID}>
          {t("create")}
        </Button>
      }
    >
      {error && (
        <p role="alert" className="mb-4 text-sm text-danger">
          {error}
        </p>
      )}

      <Card className="mb-6">
        <form id={FORM_ID} onSubmit={createBrand} className="flex flex-wrap items-end gap-3">
          <Input
            id={NAME_INPUT_ID}
            value={name}
            onChange={(e) => setName(e.target.value)}
            label={t("namePlaceholder")}
            required
            className="min-w-[220px] flex-1"
          />
        </form>
      </Card>

      {isEmpty && (
        <Card padded={false}>
          <EmptyState
            icon={<IconBrands size={22} />}
            title={t("empty")}
            action={
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={() => document.getElementById(NAME_INPUT_ID)?.focus()}
              >
                {t("emptyCreateAction")}
              </Button>
            }
          />
        </Card>
      )}

      {!isEmpty && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(brands ?? []).map((b) => (
            <Link
              key={b.id}
              href={`/${locale}/brands/${b.id}`}
              className={[
                "flex items-center justify-between gap-3 rounded-card border border-border bg-panel p-4 shadow-card transition-colors",
                "hover:bg-bg-sunken",
              ].join(" ")}
            >
              {/* Only b.name renders as text inside the link — its accessible
                  name has to stay exactly the brand name (a brands-list test
                  looks the link up by that name), so every other node here
                  (icon, chevron) is aria-hidden. */}
              <span className="flex min-w-0 items-center gap-2.5">
                <span
                  aria-hidden="true"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-accent-soft text-accent-soft-fg"
                >
                  <IconBrands size={20} />
                </span>
                <span className="truncate text-[15px] font-semibold text-fg">{b.name}</span>
              </span>
              <IconChevronRight size={16} className="shrink-0 text-fg-tertiary" />
            </Link>
          ))}
        </div>
      )}
    </AppShell>
  );
}
