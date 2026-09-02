"use client";

import { NON_SECRET_FIELDS, PLATFORM_FIELDS, PLATFORM_IDS } from "@pubrick/shared";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { use, useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { ListRow } from "@/components/ui/list-row";
import { Modal } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, api, errorMessage } from "@/lib/api";
import { channelLabel, credentialFieldLabel, platformName } from "@/lib/platform";

type Channel = { id: string; platform: string; name: string };
type Brand = { id: string; name: string };
type VerifyResult = { ok: true; account: string; target: string } | { ok: false; reason: string };

type PlatformId = (typeof PLATFORM_IDS)[number];

// The add-channel form's id — the AppShell header's primary-action button
// lives outside the <form> element (constitution: submit is top-right in
// the toolbar, not at the bottom of the form) and is wired back to it via
// `form={FORM_ID}` on a real type="submit" button.
const FORM_ID = "channel-add-form";

// Explicit id (not Input's auto-generated one) so the empty state's action can
// focus the first field of the add form without lifting a ref just for that.
const NAME_INPUT_ID = "channel-name";

export default function BrandPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations("Channels");
  const locale = useLocale();
  const router = useRouter();
  const [brand, setBrand] = useState<Brand | null>(null);
  // `null` is "not asked yet / could not ask", never "none" — the same
  // distinction the title skeleton below already draws, and the one the
  // channels list was missing.
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [channelsError, setChannelsError] = useState<string | null>(null);
  const [platform, setPlatform] = useState<PlatformId>("telegram");
  const [name, setName] = useState("");
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, VerifyResult | "loading">>({});
  // POST /api/channels is not idempotent: the same credentials submitted twice
  // make two channels, and every future post goes out twice. A click is a
  // discrete React event, so `disabled` is on the button in the DOM before an
  // impatient second click can be dispatched — and a disabled submit takes
  // Enter-in-the-field with it.
  const [busy, setBusy] = useState(false);
  // Removing a channel destroys credentials that are encrypted at rest and
  // never returned by any endpoint: nothing on this screen, and nothing in the
  // database, can put them back. Hence a confirmation — and a `Modal` rather
  // than `confirm()`, which the constitution bans.
  const [pendingRemoval, setPendingRemoval] = useState<Channel | null>(null);

  // A 403 from ActiveOrgGuard means the account has no organization yet — that is
  // an onboarding step, not an error to show the user. Every other failure
  // (including a network failure, which api() now wraps as ApiError(0, ...))
  // renders through errorMessage() so nobody sees a raw browser error string.
  // Returns the sentence to show, or null when it has been handled by
  // navigating away.
  const describeError = useCallback(
    (err: unknown): string | null => {
      if (err instanceof ApiError && err.noActiveOrg) {
        router.replace(`/${locale}/onboarding`);
        return null;
      }
      return errorMessage(err, t("genericError"));
    },
    [router, locale, t],
  );

  const load = useCallback(() => {
    api<Brand>(`/api/brands/${id}`)
      .then(setBrand)
      .catch((err) => setError(describeError(err)));
    setChannelsError(null);
    api<Channel[]>(`/api/channels?brandId=${id}`)
      .then(setChannels)
      .catch((err) => {
        // This used to be `.catch(() => {})`. A 500 or a dead network then
        // rendered the brand name, the "Channels" heading and the add form
        // with no list — which is precisely what a brand with no channels
        // looks like, so the reader concluded there were none and started
        // adding a duplicate of one that already exists.
        const message = describeError(err);
        if (message === null) return;
        setChannels(null);
        setChannelsError(message);
      });
  }, [id, describeError]);

  useEffect(load, [load]);

  async function addChannel(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api("/api/channels", {
        method: "POST",
        body: JSON.stringify({ brandId: id, platform, name, credentials: creds }),
      });
      setName("");
      setCreds({});
      load();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(channelId: string) {
    setError(null);
    setPendingRemoval(null);
    try {
      await api(`/api/channels/${channelId}`, { method: "DELETE" });
      load();
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function testConnection(channelId: string) {
    setTestResults((prev) => ({ ...prev, [channelId]: "loading" }));
    try {
      const result = await api<VerifyResult>(`/api/channels/${channelId}/test`, { method: "POST" });
      setTestResults((prev) => ({ ...prev, [channelId]: result }));
    } catch (err) {
      // errorMessage() keeps a specific 4xx verdict from the verify endpoint
      // ("wrong bot token", etc.) but swaps a network/5xx failure for the
      // translated generic text instead of a raw browser error string.
      setTestResults((prev) => ({
        ...prev,
        [channelId]: { ok: false, reason: errorMessage(err, t("genericError")) },
      }));
    }
  }

  const fields = PLATFORM_FIELDS[platform];

  return (
    <AppShell
      title={brand ? brand.name : <Skeleton lines={1} className="w-40" />}
      primaryAction={
        <Button type="submit" form={FORM_ID} disabled={busy}>
          {t("add")}
        </Button>
      }
    >
      {error && (
        <p role="alert" className="mb-4 text-sm text-danger">
          {error}
        </p>
      )}

      <h2 className="mb-3 text-lg font-semibold text-fg">{t("title")}</h2>

      {/* Failed / not answered yet / genuinely none — three different things
          to say, where there used to be one silence for all three. */}
      {channelsError !== null ? (
        <Card padded={false} className="mb-6">
          <EmptyState
            title={t("listError")}
            action={
              <Button variant="secondary" size="sm" type="button" onClick={load}>
                {t("retry")}
              </Button>
            }
          />
          <p role="alert" className="px-6 pb-6 text-center text-sm text-danger">
            {channelsError}
          </p>
        </Card>
      ) : channels === null ? (
        <div aria-busy="true" className="mb-6 rounded-card border border-border bg-panel px-4 py-3">
          <Skeleton lines={2} />
        </div>
      ) : channels.length === 0 ? (
        <Card padded={false} className="mb-6">
          <EmptyState
            title={t("empty")}
            action={
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={() => document.getElementById(NAME_INPUT_ID)?.focus()}
              >
                {t("emptyAddAction")}
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="mb-6 overflow-hidden rounded-card border border-border bg-panel">
          {channels.map((c) => {
            const result = testResults[c.id];
            return (
              <ListRow
                key={c.id}
                title={channelLabel(c.platform, c.name)}
                meta={
                  // Plain strings for the loading/ok cases — NOT wrapped in an
                  // extra <span> — because ListRow already wraps `meta` in one
                  // span of its own; a redundant inner span would give the ok
                  // case's exact-text test two elements with identical
                  // textContent and RTL's getByText would refuse to pick one.
                  // The failure case needs a real element for role="alert", so
                  // it stays an element — that test matches by role, not text,
                  // so the double wrapper there is harmless.
                  result === "loading" ? (
                    "…"
                  ) : result && !result.ok ? (
                    <span role="alert" className="text-danger">
                      {result.reason}
                    </span>
                  ) : result?.ok ? (
                    t("testOk", { account: result.account, target: result.target })
                  ) : undefined
                }
                trailing={
                  <>
                    <Button size="sm" variant="secondary" onClick={() => testConnection(c.id)}>
                      {t("test")}
                    </Button>
                    {/* Deliberately a plain visible Button, not tucked behind
                        the Menu component: a page test looks this up directly
                        via getByRole("button", { name: /remove/i }) with no
                        prior click to open anything — putting it in a Menu
                        (whose items render role="menuitem", not "button",
                        and stay hidden until the trigger opens) would break
                        that lookup. It opens the confirmation below; it is not
                        the delete. */}
                    <Button size="sm" variant="danger" onClick={() => setPendingRemoval(c)}>
                      {t("remove")}
                    </Button>
                  </>
                }
              />
            );
          })}
        </div>
      )}

      <Card>
        <form id={FORM_ID} onSubmit={addChannel} className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-3">
            <Select
              label={t("platformLabel")}
              value={platform}
              onChange={(e) => {
                setPlatform(e.target.value as PlatformId);
                // Drop the previous platform's values: leftover keys would be
                // submitted and encrypted alongside (or instead of) the ones
                // this platform needs.
                setCreds({});
              }}
              className="min-w-[160px]"
            >
              {PLATFORM_IDS.map((p) => (
                <option key={p} value={p}>
                  {platformName(p)}
                </option>
              ))}
            </Select>
            <Input
              id={NAME_INPUT_ID}
              value={name}
              onChange={(e) => setName(e.target.value)}
              label={t("namePlaceholder")}
              required
              className="min-w-[200px] flex-1"
            />
          </div>
          <div className="flex flex-wrap gap-3">
            {fields.map((f) => (
              <Input
                key={f}
                type={NON_SECRET_FIELDS.has(f) ? "text" : "password"}
                autoComplete="off"
                value={creds[f] ?? ""}
                onChange={(e) => setCreds({ ...creds, [f]: e.target.value })}
                label={credentialFieldLabel(f)}
                required
                className="min-w-[200px] flex-1"
              />
            ))}
          </div>
        </form>
      </Card>

      <Modal
        open={pendingRemoval !== null}
        onClose={() => setPendingRemoval(null)}
        title={t("removeTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPendingRemoval(null)}>
              {t("removeCancel")}
            </Button>
            {/* Same one word as the row's button: the act has one verb. */}
            <Button variant="danger" onClick={() => pendingRemoval && remove(pendingRemoval.id)}>
              {t("remove")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-fg-secondary">
          {t("removeBody", {
            channel:
              pendingRemoval === null
                ? ""
                : channelLabel(pendingRemoval.platform, pendingRemoval.name),
          })}
        </p>
      </Modal>
    </AppShell>
  );
}
