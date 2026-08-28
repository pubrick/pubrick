"use client";

import { NON_SECRET_FIELDS, PLATFORM_FIELDS, PLATFORM_IDS } from "@pubrick/shared";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { use, useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ListRow } from "@/components/ui/list-row";
import { Select } from "@/components/ui/select";
import { ApiError, api, errorMessage } from "@/lib/api";
import { channelLabel, credentialFieldLabel, platformName } from "@/lib/platform";

type Channel = { id: string; platform: string; name: string };
type Brand = { id: string; name: string };
type VerifyResult = { ok: true; account: string; target: string } | { ok: false; reason: string };

type PlatformId = (typeof PLATFORM_IDS)[number];

export default function BrandPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations("Channels");
  const locale = useLocale();
  const router = useRouter();
  const [brand, setBrand] = useState<Brand | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [platform, setPlatform] = useState<PlatformId>("telegram");
  const [name, setName] = useState("");
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, VerifyResult | "loading">>({});

  // A 403 from ActiveOrgGuard means the account has no organization yet — that is
  // an onboarding step, not an error to show the user. Every other failure
  // (including a network failure, which api() now wraps as ApiError(0, ...))
  // renders through errorMessage() so nobody sees a raw browser error string.
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
    api<Brand>(`/api/brands/${id}`).then(setBrand).catch(handleError);
    api<Channel[]>(`/api/channels?brandId=${id}`)
      .then(setChannels)
      .catch(() => {});
  }, [id, handleError]);

  useEffect(load, [load]);

  async function addChannel(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api("/api/channels", {
        method: "POST",
        body: JSON.stringify({ brandId: id, platform, name, credentials: creds }),
      });
      setName("");
      setCreds({});
      load();
    } catch (err) {
      handleError(err);
    }
  }

  async function remove(channelId: string) {
    setError(null);
    try {
      await api(`/api/channels/${channelId}`, { method: "DELETE" });
      load();
    } catch (err) {
      handleError(err);
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
    <AppShell title={brand?.name ?? ""}>
      {error && (
        <p role="alert" className="mb-4 text-sm text-danger">
          {error}
        </p>
      )}

      <h2 className="mb-3 text-lg font-semibold text-fg">{t("title")}</h2>

      {channels.length > 0 && (
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
                        that lookup. */}
                    <Button size="sm" variant="danger" onClick={() => remove(c.id)}>
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
        <form onSubmit={addChannel} className="flex flex-col gap-3">
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
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("namePlaceholder")}
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
                placeholder={f}
                label={credentialFieldLabel(f)}
                required
                className="min-w-[200px] flex-1"
              />
            ))}
          </div>
          <div>
            <Button type="submit">{t("add")}</Button>
          </div>
        </form>
      </Card>
    </AppShell>
  );
}
