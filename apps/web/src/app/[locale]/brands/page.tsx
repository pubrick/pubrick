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
import { Skeleton } from "@/components/ui/skeleton";
import { TRANSITION_COLORS } from "@/components/ui/transition";
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
  // The refusals' own namespace. Both places this screen shows a failure — the
  // sentence beside the create form, and the one under the list's empty state —
  // are written by `describeError`, so one translator serves both.
  const te = useTranslations("Errors");
  const locale = useLocale();
  const router = useRouter();
  const [brands, setBrands] = useState<Brand[] | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Read failure and write failure are different sentences in different
  // places: "we could not fetch your brands" belongs where the list would
  // have been, "that name is taken" belongs by the form.
  const [listError, setListError] = useState<string | null>(null);
  // POST /api/brands is not idempotent on the name — a double-click makes two
  // brands with the same name, and the second one is a row the person never
  // asked for. Same guard, same mechanism as onboarding's: a click is a
  // discrete React event, so `disabled` has flushed to the DOM before an
  // impatient second click can be dispatched, and a disabled submit takes
  // Enter-in-the-field with it.
  const [busy, setBusy] = useState(false);

  // A 403 from ActiveOrgGuard means the account has no organization yet — that is an
  // onboarding step, not an error to show the user. Returns the sentence to
  // show, or null when it has already been handled by navigating away.
  const describeError = useCallback(
    (err: unknown): string | null => {
      if (err instanceof ApiError && err.noActiveOrg) {
        router.replace(`/${locale}/onboarding`);
        return null;
      }
      return errorMessage(err, t("genericError"), te);
    },
    [router, locale, t, te],
  );

  const load = useCallback(() => {
    setListError(null);
    api<Brand[]>("/api/brands")
      .then(setBrands)
      .catch((err) => {
        const message = describeError(err);
        if (message === null) return;
        // Back to "unknown", never to "none": a 500 that left the previous
        // list on screen would be claiming it is current.
        setBrands(null);
        setListError(message);
      });
  }, [describeError]);

  useEffect(load, [load]);

  async function createBrand(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api("/api/brands", { method: "POST", body: JSON.stringify({ name }) });
      setName("");
      load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
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
        <Button type="submit" form={FORM_ID} disabled={busy}>
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

      {/* Three answers, three renderings, and they are not interchangeable:
          the request failed / it has not answered yet / this org has no
          brands. The list used to have one rendering for all three — an
          empty grid — so a 500 and a dead network both read as "no brands
          yet", which is the same untruth Settings' credential list was
          carrying. */}
      {listError !== null ? (
        <Card padded={false}>
          <EmptyState
            icon={<IconBrands size={22} />}
            title={t("listError")}
            action={
              <Button variant="secondary" size="sm" type="button" onClick={load}>
                {t("retry")}
              </Button>
            }
          />
          {/* The sentence above is the explanation; this carries the server's
              own words to assistive tech and to anyone debugging. */}
          <p role="alert" className="px-6 pb-6 text-center text-sm text-danger">
            {listError}
          </p>
        </Card>
      ) : brands === null ? (
        <div aria-busy="true" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((placeholder) => (
            <Card key={placeholder}>
              <Skeleton lines={1} className="py-1.5" />
            </Card>
          ))}
        </div>
      ) : isEmpty ? (
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
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {brands.map((b) => (
            <Link
              key={b.id}
              href={`/${locale}/brands/${b.id}`}
              className={[
                "flex items-center justify-between gap-3 rounded-card border border-border bg-panel p-4 shadow-card",
                TRANSITION_COLORS,
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
