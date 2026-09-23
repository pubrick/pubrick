"use client";

import {
  type BrandLinkPolicy,
  DEFAULT_CAMPAIGN_TEMPLATE,
  DEFAULT_UTM,
  isAvailablePlatform,
  isManualPlatform,
  NON_SECRET_FIELDS,
  PLATFORM_FIELDS,
  PLATFORM_IDS,
  PUBLISHABLE_PLATFORM_IDS,
} from "@pubrick/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { use, useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { FeedSettings } from "@/components/feed-controls";
import { Advanced } from "@/components/ui/advanced";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { ListRow } from "@/components/ui/list-row";
import { Modal } from "@/components/ui/modal";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, api, errorMessage } from "@/lib/api";
import { channelLabel, credentialFieldLabel, platformName } from "@/lib/platform";

type Channel = { id: string; platform: string; name: string; metricsAutoRefresh?: boolean };
/**
 * Voice, audience and language shape generation. Description is used for
 * source relevance and topic suggestions, not generation instructions.
 */
type Brand = {
  id: string;
  name: string;
  description: string | null;
  voice: string | null;
  audience: string | null;
  contentLanguage: string;
  linkPolicy: BrandLinkPolicy | null;
};
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

// The edit modal's form id: its Save button lives in the modal FOOTER, outside
// the <form>, and is wired back to it the same way the add form's header
// button is.
const EDIT_FORM_ID = "channel-edit-form";

// The brand-voice modal's form id — same arrangement, its Save is in the footer.
const VOICE_FORM_ID = "brand-voice-form";
const PROFILE_FORM_ID = "brand-profile-form";
const LINKS_FORM_ID = "brand-links-form";

// The language field's hint is a sibling paragraph rather than a placeholder:
// the field is always prefilled, so a placeholder would never be seen.
const LANGUAGE_HINT_ID = "brand-language-hint";

/**
 * The picker's two groups.
 *
 * Every platform this product names is still shown, and those with no
 * adapter are shown as what they are — `disabled`, under a heading that says
 * so — rather than hidden. Hiding them would answer "does Pubrick support this?"
 * with silence; the honest answer is "not yet", and this is a product whose
 * pitch is not overstating what it did. The browser will not let a disabled
 * option be selected, so nobody can reach the credential fields for one, and
 * `POST /api/channels` refuses the same set server-side (derived there from the
 * publisher registry) in case anything ever does.
 */
const OFFERED_PLATFORMS = PLATFORM_IDS.filter((p) => isAvailablePlatform(p));
const UNSUPPORTED_PLATFORMS = PLATFORM_IDS.filter((p) => !isAvailablePlatform(p));

/**
 * The picker's initial value, taken from the available set rather than
 * written down again: a hard-coded `"telegram"` would put an unselectable
 * platform in `platform` the day Telegram's adapter is the one that goes.
 */
const DEFAULT_PLATFORM: PlatformId = PUBLISHABLE_PLATFORM_IDS[0];

export default function BrandPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations("Channels");
  const tb = useTranslations("Brands");
  /**
   * The refusals' own namespace. This screen renders a failure in FIVE places —
   * the sentence at the top, the one under the channel list, one inside each of
   * the two modals, and the verdict beside a channel's Test button — and they
   * are fed by exactly two calls into `errorMessage`: `describeError` and
   * `testConnection`. Both take this, or four of the five stay English.
   */
  const te = useTranslations("Errors");
  const locale = useLocale();
  const router = useRouter();
  const [brand, setBrand] = useState<Brand | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileName, setProfileName] = useState("");
  const [profileDescription, setProfileDescription] = useState("");
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileBusy, setProfileBusy] = useState(false);
  const closeProfileEditor = useCallback(() => setProfileOpen(false), []);
  const [linksOpen, setLinksOpen] = useState(false);
  const [websiteDraft, setWebsiteDraft] = useState("");
  const [campaignDraft, setCampaignDraft] = useState(DEFAULT_CAMPAIGN_TEMPLATE);
  const [platformDraft, setPlatformDraft] = useState<BrandLinkPolicy["platforms"]>({});
  const [linksError, setLinksError] = useState<string | null>(null);
  const [linksBusy, setLinksBusy] = useState(false);
  // `null` is "not asked yet / could not ask", never "none" — the same
  // distinction the title skeleton below already draws, and the one the
  // channels list was missing.
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [channelsError, setChannelsError] = useState<string | null>(null);
  const [platform, setPlatform] = useState<PlatformId>(DEFAULT_PLATFORM);
  const [name, setName] = useState("");
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, VerifyResult | "loading">>({});
  const [metricsBusy, setMetricsBusy] = useState<string | null>(null);
  const [metricsError, setMetricsError] = useState<Record<string, string>>({});
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
  // Editing a channel is what makes rotating a revoked token something other
  // than deleting the channel and losing every scheduled post with it. The
  // credential fields open EMPTY, always: no endpoint returns the stored bag,
  // so there is nothing to prefill and a placeholder pretending otherwise would
  // be a lie the Save button would then act on.
  const [editing, setEditing] = useState<Channel | null>(null);
  const [editName, setEditName] = useState("");
  const [editCreds, setEditCreds] = useState<Record<string, string>>({});
  const [editError, setEditError] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  // The brand's own settings — the three fields every generation prompt
  // interpolates. Unlike the channel credentials above these ARE readable, so
  // the modal opens prefilled with what is stored and Save sends all three:
  // clearing a field is a deliberate act with a meaning (the prompt omits the
  // line rather than telling the model the voice is empty).
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [voiceDraft, setVoiceDraft] = useState("");
  const [audienceDraft, setAudienceDraft] = useState("");
  const [languageDraft, setLanguageDraft] = useState("");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voiceBusy, setVoiceBusy] = useState(false);

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
      return errorMessage(err, t("genericError"), te);
    },
    [router, locale, t, te],
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

  function startProfileEditing() {
    if (!brand) return;
    setProfileName(brand.name);
    setProfileDescription(brand.description ?? "");
    setProfileError(null);
    setProfileOpen(true);
  }

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setProfileError(null);
    setProfileBusy(true);
    try {
      const updated = await api<Brand>(`/api/brands/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: profileName.trim(), description: profileDescription.trim() }),
      });
      setBrand(updated);
      setProfileOpen(false);
    } catch (err) {
      setProfileError(describeError(err));
    } finally {
      setProfileBusy(false);
    }
  }

  async function addChannel(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api("/api/channels", {
        method: "POST",
        body: JSON.stringify({
          brandId: id,
          platform,
          name,
          ...(isManualPlatform(platform) ? {} : { credentials: creds }),
        }),
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

  /**
   * STABLE, and that is load-bearing rather than tidiness. `Modal`'s focus-trap
   * effect depends on `[open, onClose]`, and its body focuses the dialog: a new
   * closure here on every render re-runs that effect on every keystroke and
   * pulls focus out of whatever field is being typed into. The symptom is a
   * credential field that accepts exactly one character — which is how this was
   * found, by the rotation test above. The removal modal never noticed because
   * it has nothing to type into.
   */
  const closeEditor = useCallback(() => setEditing(null), []);

  function startEditing(channel: Channel) {
    setEditing(channel);
    setEditName(channel.name);
    setEditCreds({});
    setEditError(null);
  }

  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (editing === null) return;
    const fields = PLATFORM_FIELDS[editing.platform as PlatformId] ?? [];
    const filled = fields.filter((f) => (editCreds[f] ?? "").trim() !== "");
    // ALL OR NOTHING, and refused here rather than sent. `PATCH /channels/:id`
    // REPLACES the stored bag — it cannot merge, because no endpoint returns
    // what is already there to merge into. A half-filled form would therefore
    // install a chatId with no botToken beside it, and the channel would fail
    // at the one moment that matters, the next send.
    if (filled.length > 0 && filled.length < fields.length) {
      setEditError(t("editCredsPartial"));
      return;
    }
    setEditError(null);
    setEditBusy(true);
    try {
      await api(`/api/channels/${editing.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: editName,
          ...(filled.length === 0 ? {} : { credentials: editCreds }),
        }),
      });
      setEditing(null);
      // A rotation invalidates whatever the last connection test said about
      // this channel, so the verdict beside it is dropped rather than left to
      // describe a token that is gone.
      setTestResults((prev) => {
        const next = { ...prev };
        delete next[editing.id];
        return next;
      });
      load();
    } catch (err) {
      setEditError(describeError(err));
    } finally {
      setEditBusy(false);
    }
  }

  /**
   * STABLE for the same reason `closeEditor` is: `Modal`'s focus-trap effect
   * depends on `[open, onClose]`, and a new closure on every render re-runs it
   * on every keystroke, pulling focus out of the field being typed into. The
   * symptom is a textarea that accepts exactly one character.
   */
  const closeVoiceEditor = useCallback(() => setVoiceOpen(false), []);
  const closeLinksEditor = useCallback(() => setLinksOpen(false), []);

  function startLinksEditing() {
    if (!brand) return;
    setWebsiteDraft(brand.linkPolicy?.website ?? "");
    setCampaignDraft(brand.linkPolicy?.campaignTemplate ?? DEFAULT_CAMPAIGN_TEMPLATE);
    setPlatformDraft(brand.linkPolicy?.platforms ?? {});
    setLinksError(null);
    setLinksOpen(true);
  }

  async function saveLinks(e: React.FormEvent) {
    e.preventDefault();
    setLinksError(null);
    setLinksBusy(true);
    try {
      const linkPolicy = websiteDraft.trim()
        ? {
            website: websiteDraft.trim(),
            campaignTemplate: campaignDraft.trim(),
            platforms: platformDraft,
          }
        : null;
      const updated = await api<Brand>(`/api/brands/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ linkPolicy }),
      });
      setBrand(updated);
      setLinksOpen(false);
    } catch (err) {
      setLinksError(describeError(err));
    } finally {
      setLinksBusy(false);
    }
  }

  function startVoiceEditing() {
    if (brand === null) return;
    setVoiceDraft(brand.voice ?? "");
    setAudienceDraft(brand.audience ?? "");
    setLanguageDraft(brand.contentLanguage);
    setVoiceError(null);
    setVoiceOpen(true);
  }

  /**
   * Writes the three fields the model is instructed with.
   *
   * All three go in one PATCH, including the ones that did not change: this is
   * a form, not a diff, and `brandUpdateSchema` accepts each independently. An
   * empty voice or audience is sent as `""` on purpose — that is how a person
   * un-sets one, and the prompt builder omits an empty line rather than telling
   * the model the brand's voice is nothing.
   */
  async function saveVoice(e: React.FormEvent) {
    e.preventDefault();
    setVoiceError(null);
    setVoiceBusy(true);
    try {
      const updated = await api<Brand>(`/api/brands/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          voice: voiceDraft,
          audience: audienceDraft,
          contentLanguage: languageDraft,
        }),
      });
      // The server's row, not the draft: `contentLanguage` has a default and
      // every field is bounded there, so the card must show what was stored.
      setBrand(updated);
      setVoiceOpen(false);
    } catch (err) {
      setVoiceError(describeError(err));
    } finally {
      setVoiceBusy(false);
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
        [channelId]: { ok: false, reason: errorMessage(err, t("genericError"), te) },
      }));
    }
  }

  async function toggleMetrics(channel: Channel) {
    setMetricsBusy(channel.id);
    setMetricsError((previous) => ({ ...previous, [channel.id]: "" }));
    try {
      const updated = await api<Channel>(`/api/channels/${channel.id}`, {
        method: "PATCH",
        body: JSON.stringify({ metricsAutoRefresh: !channel.metricsAutoRefresh }),
      });
      setChannels(
        (previous) => previous?.map((item) => (item.id === channel.id ? updated : item)) ?? null,
      );
    } catch (err) {
      const message = describeError(err);
      if (message) setMetricsError((previous) => ({ ...previous, [channel.id]: message }));
    } finally {
      setMetricsBusy(null);
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
      <div className="mb-5 flex flex-wrap gap-4 text-sm font-medium">
        <Link href={`/${locale}/brands/${id}/sources`} className="text-accent underline">
          {tb("sourcesLink")}
        </Link>
        <Link href={`/${locale}/brands/${id}/calendar`} className="text-accent underline">
          {tb("calendarLink")}
        </Link>
        <Link href={`/${locale}/brands/${id}/topics`} className="text-accent underline">
          {tb("topicsLink")}
        </Link>
        <Link href={`/${locale}/brands/${id}/media`} className="text-accent underline">
          {tb("mediaLink")}
        </Link>
        <Link href={`/${locale}/brands/${id}/analytics`} className="text-accent underline">
          {tb("analyticsLink")}
        </Link>
      </div>
      {error && (
        <p role="alert" className="mb-4 text-sm text-danger">
          {error}
        </p>
      )}

      <Card className="mb-6">
        <div className="mb-2 flex items-start justify-between gap-3">
          <h2 className="text-lg font-semibold text-fg">{tb("profileTitle")}</h2>
          <Button
            size="sm"
            variant="secondary"
            type="button"
            onClick={startProfileEditing}
            disabled={!brand}
          >
            {tb("profileEdit")}
          </Button>
        </div>
        <p className="mb-4 text-sm text-fg-secondary">{tb("descriptionHint")}</p>
        {brand === null ? (
          <div aria-busy="true">
            <Skeleton lines={2} />
          </div>
        ) : (
          <dl className="grid gap-4 sm:grid-cols-2">
            <div>
              <dt className="text-sm font-medium text-fg-secondary">{tb("nameLabel")}</dt>
              <dd className="mt-1 break-words text-sm text-fg">{brand.name}</dd>
            </div>
            <div>
              <dt className="text-sm font-medium text-fg-secondary">{tb("descriptionLabel")}</dt>
              <dd
                className={
                  brand.description?.trim()
                    ? "mt-1 whitespace-pre-wrap text-sm text-fg"
                    : "mt-1 text-sm text-fg-tertiary"
                }
              >
                {brand.description?.trim() ? brand.description : tb("descriptionUnset")}
              </dd>
            </div>
          </dl>
        )}
      </Card>

      {/* Voice, audience and content language are interpolated into generation
          instructions. Description above has a separate targeting purpose. */}
      <Card className="mb-6">
        <div className="mb-2 flex items-start justify-between gap-3">
          <h2 className="text-lg font-semibold text-fg">{tb("voiceTitle")}</h2>
          <Button
            size="sm"
            variant="secondary"
            type="button"
            onClick={startVoiceEditing}
            disabled={brand === null}
          >
            {tb("voiceEdit")}
          </Button>
        </div>
        <p className="mb-4 text-sm text-fg-secondary">{tb("voiceHint")}</p>
        {brand === null ? (
          <div aria-busy="true">
            <Skeleton lines={3} />
          </div>
        ) : (
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {[
              { key: "voice", label: tb("voiceLabel"), value: brand.voice },
              { key: "audience", label: tb("audienceLabel"), value: brand.audience },
              { key: "language", label: tb("languageLabel"), value: brand.contentLanguage },
            ].map((field) => (
              <div key={field.key} className="flex min-w-0 flex-col gap-1">
                <dt className="text-sm font-medium text-fg-secondary">{field.label}</dt>
                <dd
                  className={
                    (field.value ?? "").trim() === ""
                      ? "text-sm text-fg-tertiary"
                      : "whitespace-pre-wrap text-sm text-fg"
                  }
                >
                  {(field.value ?? "").trim() === "" ? tb("voiceUnset") : field.value}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </Card>

      <Card className="mb-6">
        <div className="mb-2 flex items-start justify-between gap-3">
          <h2 className="text-lg font-semibold text-fg">{tb("linksTitle")}</h2>
          <Button
            size="sm"
            variant="secondary"
            type="button"
            onClick={startLinksEditing}
            disabled={!brand}
          >
            {tb("linksEdit")}
          </Button>
        </div>
        <p className="text-sm text-fg-secondary">{tb("linksHint")}</p>
        {brand?.linkPolicy ? (
          <p className="mt-3 break-all text-sm font-medium text-fg">{brand.linkPolicy.website}</p>
        ) : (
          <p className="mt-3 text-sm text-fg-tertiary">{tb("linksUnset")}</p>
        )}
      </Card>

      <Card className="mb-6">
        <h2 className="text-lg font-semibold text-fg">{tb("knowledgeTitle")}</h2>
        <p className="mt-2 text-sm text-fg-secondary">{tb("knowledgeHint")}</p>
        <Link
          href={`/${locale}/brands/${id}/knowledge`}
          className="mt-3 inline-block text-sm font-semibold text-accent underline-offset-2 hover:underline"
        >
          {tb("knowledgeOpen")}
        </Link>
      </Card>

      <h2 id="channels" className="mb-3 scroll-mt-6 text-lg font-semibold text-fg">
        {t("title")}
      </h2>

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
                  metricsError[c.id] ? (
                    <span role="alert" className="text-danger">
                      {metricsError[c.id]}
                    </span>
                  ) : isManualPlatform(c.platform) ? (
                    t("vcManualMeta")
                  ) : result === "loading" ? (
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
                    {c.platform === "vk" && (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={metricsBusy === c.id}
                        onClick={() => toggleMetrics(c)}
                        aria-label={
                          c.metricsAutoRefresh ? t("autoMetricsDisable") : t("autoMetricsEnable")
                        }
                        title={t("autoMetricsHint")}
                      >
                        {c.metricsAutoRefresh ? t("autoMetricsOn") : t("autoMetricsOff")}
                      </Button>
                    )}
                    {!isManualPlatform(c.platform) && (
                      <Button size="sm" variant="secondary" onClick={() => testConnection(c.id)}>
                        {t("test")}
                      </Button>
                    )}
                    <Button size="sm" variant="secondary" onClick={() => startEditing(c)}>
                      {t("edit")}
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
              {OFFERED_PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  {platformName(p)}
                </option>
              ))}
              {/* Named, and plainly marked as not yet deliverable. Disabled
                  rather than hidden: hiding them answers "does Pubrick support
                  a platform?" with silence, and this is the product that refuses to
                  overstate what it can do. The browser will not select a
                  disabled option, so the credential fields for one are
                  unreachable — and `POST /api/channels` refuses the same set
                  anyway, derived from the publisher registry. */}
              {UNSUPPORTED_PLATFORMS.length > 0 && (
                <optgroup label={t("platformUnsupported")}>
                  {UNSUPPORTED_PLATFORMS.map((p) => (
                    <option key={p} value={p} disabled>
                      {platformName(p)}
                    </option>
                  ))}
                </optgroup>
              )}
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
          {platform === "vk" && <p className="text-sm text-fg-secondary">{t("vkTokenHint")}</p>}
          {platform === "max" && <p className="text-sm text-fg-secondary">{t("maxTokenHint")}</p>}
          {platform === "bluesky" && (
            <p className="text-sm text-fg-secondary">{t("blueskyAppPasswordHint")}</p>
          )}
          {platform === "mastodon" && (
            <p className="text-sm text-fg-secondary">{t("mastodonTokenHint")}</p>
          )}
          {platform === "vc_ru" && <p className="text-sm text-fg-secondary">{t("vcManualHint")}</p>}
        </form>
      </Card>

      <FeedSettings brandId={id} />

      <Modal
        open={editing !== null}
        onClose={closeEditor}
        title={t("editTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={closeEditor}>
              {t("editCancel")}
            </Button>
            <Button type="submit" form={EDIT_FORM_ID} disabled={editBusy}>
              {t("editSave")}
            </Button>
          </>
        }
      >
        <form id={EDIT_FORM_ID} onSubmit={saveEdit} className="flex flex-col gap-3">
          {editError && (
            <p role="alert" className="text-sm text-danger">
              {editError}
            </p>
          )}
          <Input
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            label={t("namePlaceholder")}
            required
          />
          {editing?.platform === "vc_ru" ? (
            <p className="text-sm text-fg-secondary">{t("vcManualHint")}</p>
          ) : (
            <p className="text-sm text-fg-secondary">{t("editCredsHint")}</p>
          )}
          {editing?.platform === "vk" && (
            <p className="text-sm text-fg-secondary">{t("vkTokenHint")}</p>
          )}
          {editing?.platform === "max" && (
            <p className="text-sm text-fg-secondary">{t("maxTokenHint")}</p>
          )}
          {editing?.platform === "bluesky" && (
            <p className="text-sm text-fg-secondary">{t("blueskyAppPasswordHint")}</p>
          )}
          {editing?.platform === "mastodon" && (
            <p className="text-sm text-fg-secondary">{t("mastodonTokenHint")}</p>
          )}
          {(editing === null ? [] : (PLATFORM_FIELDS[editing.platform as PlatformId] ?? [])).map(
            (f) => (
              <Input
                key={f}
                type={NON_SECRET_FIELDS.has(f) ? "text" : "password"}
                autoComplete="off"
                value={editCreds[f] ?? ""}
                onChange={(e) => setEditCreds({ ...editCreds, [f]: e.target.value })}
                label={credentialFieldLabel(f)}
              />
            ),
          )}
        </form>
      </Modal>

      <Modal
        open={profileOpen}
        onClose={closeProfileEditor}
        title={tb("profileTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={closeProfileEditor}>
              {tb("voiceCancel")}
            </Button>
            <Button type="submit" form={PROFILE_FORM_ID} disabled={profileBusy}>
              {tb("voiceSave")}
            </Button>
          </>
        }
      >
        <form id={PROFILE_FORM_ID} onSubmit={saveProfile} className="flex flex-col gap-3">
          {profileError && (
            <p role="alert" className="text-sm text-danger">
              {profileError}
            </p>
          )}
          <Input
            value={profileName}
            onChange={(e) => setProfileName(e.target.value)}
            label={tb("nameLabel")}
            required
            maxLength={200}
          />
          <Textarea
            value={profileDescription}
            onChange={(e) => setProfileDescription(e.target.value)}
            label={tb("descriptionLabel")}
            maxLength={2000}
          />
          <p className="text-sm text-fg-secondary">{tb("descriptionHint")}</p>
        </form>
      </Modal>

      <Modal
        open={voiceOpen}
        onClose={closeVoiceEditor}
        title={tb("voiceTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={closeVoiceEditor}>
              {tb("voiceCancel")}
            </Button>
            <Button type="submit" form={VOICE_FORM_ID} disabled={voiceBusy}>
              {tb("voiceSave")}
            </Button>
          </>
        }
      >
        <form id={VOICE_FORM_ID} onSubmit={saveVoice} className="flex flex-col gap-3">
          {voiceError && (
            <p role="alert" className="text-sm text-danger">
              {voiceError}
            </p>
          )}
          <Textarea
            value={voiceDraft}
            onChange={(e) => setVoiceDraft(e.target.value)}
            label={tb("voiceLabel")}
            placeholder={tb("voicePlaceholder")}
            maxLength={2000}
            showCount
          />
          <Textarea
            value={audienceDraft}
            onChange={(e) => setAudienceDraft(e.target.value)}
            label={tb("audienceLabel")}
            placeholder={tb("audiencePlaceholder")}
            maxLength={2000}
            showCount
          />
          {/* A free-text code, bounded exactly as `brandCreateSchema` bounds it
              (2–10 characters). Not a fixed menu: the prompt says "write in the
              language with code X" and a self-hoster writing in a language no
              menu of ours would list must be able to say so. */}
          <div className="flex flex-col gap-1.5">
            <Input
              value={languageDraft}
              onChange={(e) => setLanguageDraft(e.target.value)}
              label={tb("languageLabel")}
              aria-describedby={LANGUAGE_HINT_ID}
              minLength={2}
              maxLength={10}
              required
            />
            <p id={LANGUAGE_HINT_ID} className="text-xs text-fg-tertiary">
              {tb("languageHint")}
            </p>
          </div>
        </form>
      </Modal>

      <Modal
        open={linksOpen}
        onClose={closeLinksEditor}
        title={tb("linksTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={closeLinksEditor}>
              {tb("voiceCancel")}
            </Button>
            <Button type="submit" form={LINKS_FORM_ID} disabled={linksBusy}>
              {tb("voiceSave")}
            </Button>
          </>
        }
      >
        <form id={LINKS_FORM_ID} onSubmit={saveLinks} className="flex flex-col gap-3">
          {linksError && (
            <p role="alert" className="text-sm text-danger">
              {linksError}
            </p>
          )}
          <p className="text-sm text-fg-secondary">{tb("linksFormHint")}</p>
          <Input
            type="url"
            value={websiteDraft}
            onChange={(e) => setWebsiteDraft(e.target.value)}
            label={tb("linksWebsite")}
            placeholder="https://example.com"
          />
          <Advanced
            dirty={
              campaignDraft !== DEFAULT_CAMPAIGN_TEMPLATE || Object.keys(platformDraft).length > 0
            }
          >
            <div className="flex flex-col gap-3">
              <Input
                value={campaignDraft}
                onChange={(e) => setCampaignDraft(e.target.value)}
                label={tb("linksCampaign", {
                  YYYY_MM: "{YYYY_MM}",
                  content_type: "{content_type}",
                })}
              />
              <p className="text-sm text-fg-secondary">{tb("linksPlatformsHint")}</p>
              {PLATFORM_IDS.map((p) => {
                const mapping = platformDraft[p] ?? DEFAULT_UTM[p];
                return (
                  <div key={p} className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <span className="text-sm font-medium text-fg">{platformName(p)}</span>
                    <Input
                      value={mapping.source}
                      onChange={(e) =>
                        setPlatformDraft({
                          ...platformDraft,
                          [p]: { ...mapping, source: e.target.value },
                        })
                      }
                      label={`${platformName(p)} ${tb("linksSource")}`}
                    />
                    <Input
                      value={mapping.medium}
                      onChange={(e) =>
                        setPlatformDraft({
                          ...platformDraft,
                          [p]: { ...mapping, medium: e.target.value },
                        })
                      }
                      label={`${platformName(p)} ${tb("linksMedium")}`}
                    />
                  </div>
                );
              })}
            </div>
          </Advanced>
        </form>
      </Modal>

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
          {t(pendingRemoval?.platform === "vc_ru" ? "removeManualBody" : "removeBody", {
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
