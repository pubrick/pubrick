"use client";

import {
  AI_PROVIDERS,
  type AiCredentialPublic,
  type AiCredentialTestResult,
  type AiProviderId,
  type AiTestFailure,
  type CostSummary,
  formatUsd,
  MAX_TEST_CALLS_PER_HOUR,
} from "@pubrick/shared";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { LanguageCard } from "@/components/language-card";
import { Advanced } from "@/components/ui/advanced";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { ListRow } from "@/components/ui/list-row";
import { Modal } from "@/components/ui/modal";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useSignOut } from "@/hooks/use-sign-out";
import { ApiError, api, errorMessage } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { applyTheme, readThemePref, type ThemePref } from "@/lib/theme";

/**
 * A message key for every failure the API can report.
 *
 * A total `Record` rather than a lookup with a fallback: a new code added to
 * `AI_TEST_FAILURES` is a compile error here, instead of rendering its raw key
 * path to a user in four languages. The API sends codes precisely so that a
 * provider's own 401 body — which quotes the submitted key — never reaches a
 * browser, and so that this sentence can be translated at all.
 */
const TEST_FAILURE_KEYS: Record<AiTestFailure, string> = {
  invalid_key: "aiTestFailInvalidKey",
  model_not_found: "aiTestFailModelNotFound",
  no_structured_output: "aiTestFailNoStructuredOutput",
  rate_limited: "aiTestFailRateLimited",
  refused: "aiTestFailRefused",
  timed_out: "aiTestFailTimedOut",
  too_many_tests: "aiTestFailTooManyTests",
  unreadable_key: "aiTestFailUnreadableKey",
};

/**
 * The one argument any of those sentences needs, and it does not travel on the
 * wire — exactly as `run_limit_reached`'s does not (`ERROR_MESSAGE_VALUES`,
 * lib/api.ts).
 *
 * `MAX_TEST_CALLS_PER_HOUR` is exported from `@pubrick/shared` so that the api
 * enforcing the limit and the screen explaining it cannot promise different
 * numbers. Reading it here rather than having the server send a sentence with
 * the number already in it is what keeps that true in Russian.
 */
const TEST_FAILURE_VALUES: Partial<Record<AiTestFailure, Record<string, string | number>>> = {
  too_many_tests: { limit: MAX_TEST_CALLS_PER_HOUR },
};

/**
 * What the Test button is showing for one provider.
 *
 * THREE states, not two, and the third one is a fix rather than a refinement.
 * A call that never produced a verdict — a 404 because another tab removed the
 * key, a 500, a dead network — was being stored in the API's OWN
 * `{ ok: false, reason }` shape with a SENTENCE where the code belongs, and
 * then rendered as `t(TEST_FAILURE_KEYS[reason])`: a lookup that misses, so the
 * reader got nothing at all where the refusal should have been. TypeScript did
 * not object because the assignment goes through a computed key
 * (`{ ...prev, [id]: … }`), which switches off the contextual check that would
 * have caught a `string` standing in for an `AiTestFailure`.
 *
 * A provider's verdict and a failed request are different facts, so they now
 * have different shapes and cannot be confused for one another. `failed` holds
 * a sentence that is ALREADY translated — `errorMessage` mapped the api's
 * refusal code, or fell back — which is why nothing looks it up.
 */
type TestState = "loading" | AiCredentialTestResult | { failed: string };

/** Vendor names. Wire ids are never shown raw, and brand names are not translated. */
const PROVIDER_NAMES: Record<AiProviderId, string> = {
  google: "Google",
  openrouter: "OpenRouter",
};

// The key form's id. The constitution puts the one primary action top-right in
// the toolbar, never a save button at the foot of a form, so the submit button
// lives in AppShell's header and is wired back here via `form={AI_FORM_ID}`.
const AI_FORM_ID = "ai-credential-form";

// Same mechanism for the invite dialog: the submit lives in the modal footer.
const INVITE_FORM_ID = "invite-member-form";

/**
 * What the invited person is sent, and why it is not a secret.
 *
 * There is no mailer — adding one would put SMTP configuration in front of
 * every self-hoster on their first day — so the invitation travels by hand.
 * What travels is a plain URL to this instance's onboarding screen carrying the
 * invitation's id; it is NOT a bearer credential, and the distinction is the
 * whole security argument of this flow. The id opens nothing on its own:
 * `accept-invitation` only accepts a session whose address matches the
 * invitation, and the signup gate only admits an address that has a live
 * invitation. Whoever else obtains this link learns that an instance exists.
 *
 * The credential is therefore the ADDRESS, which has a cost of its own and it
 * is stated in docs/self-hosting.md: Pubrick does not verify email, so anyone
 * who knows an invited address can register it first. Invite an address only
 * the invitee controls, and revoke the invitation if it goes astray.
 *
 * `window.location.origin` rather than a configured base URL: a self-hosted
 * instance is reached at whatever address its operator put it on, and the
 * person copying the link is looking at that address right now.
 */
function invitationLink(locale: string, invitationId: string): string {
  return `${window.location.origin}/${locale}/onboarding?invitation=${encodeURIComponent(invitationId)}`;
}

/**
 * The refusals `organization/invite-member` can hand a member, translated.
 *
 * Better Auth answers with a code and an English sentence; the sentence is what
 * every other auth screen in this app still renders, and it is English to a
 * Russian reader. These three are the ones a member can actually provoke by
 * typing; anything else falls back to this screen's own generic sentence rather
 * than to the library's prose.
 */
const INVITE_FAILURE_KEYS: Record<string, string> = {
  USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION: "peopleInviteFailMember",
  INVALID_EMAIL: "peopleInviteFailEmail",
  INVITATION_LIMIT_REACHED: "peopleInviteFailLimit",
};

/** A pending invitation as `get-full-organization` returns it. */
type OrganizationInvitation = {
  id: string;
  email: string;
  status: string;
  expiresAt: string | Date;
};

/** Live means BOTH facts, exactly as the api's gate reads them. */
function isLiveInvitation(invitation: OrganizationInvitation): boolean {
  return invitation.status === "pending" && new Date(invitation.expiresAt).getTime() > Date.now();
}

export default function SettingsPage() {
  const t = useTranslations("SettingsPage");
  // The refusals' own namespace — see the queue screen. It is what puts "no API
  // key is stored for this provider" in the reader's language when a second tab
  // removed the key between this screen loading and the Test button being hit.
  const te = useTranslations("Errors");
  const tLanding = useTranslations("Landing");
  const { data: session } = authClient.useSession();
  const {
    data: organization,
    isPending: organizationPending,
    refetch: refetchOrganization,
  } = authClient.useActiveOrganization();
  const locale = useLocale();
  const signOut = useSignOut();

  const [pref, setPref] = useState<ThemePref>("system");
  // Stored pref is client-only state: reading it during the first render makes
  // the SSR html (always "system") disagree with the client and React reports
  // a hydration mismatch — so sync it after mount instead.
  useEffect(() => {
    setPref(readThemePref());
  }, []);

  // `null` is "not loaded yet", NOT "none" — the distinction the brand detail
  // screen already draws with its title skeleton. Starting at `[]` made the
  // screen answer a question it had not asked the server yet, and the answer it
  // guessed was a definite negative: "No API key yet" flashed on every visit,
  // including the visits where a key was about to appear.
  const [credentials, setCredentials] = useState<AiCredentialPublic[] | null>(null);
  const [spend, setSpend] = useState<CostSummary | null>(null);
  // The spend read had a `.catch(() => {})`, so a 500 left the em dash the
  // loading state also shows. "Spent so far: —" reads as "nothing yet" — the
  // most reassuring of all possible answers, and the one nobody had checked.
  const [spendError, setSpendError] = useState<string | null>(null);
  const [provider, setProvider] = useState<AiProviderId>("google");
  const [apiKey, setApiKey] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [aiError, setAiError] = useState<string | null>(null);
  // PUT /api/ai-credentials is idempotent per provider, but each submit is a
  // round trip with the key still in the field: a double-click sends the
  // secret twice and races two `loadAi()` refreshes against each other. Same
  // mechanism as onboarding's guard — `disabled` reaches the DOM before a
  // second click can be dispatched, and it takes Enter-in-the-field with it.
  const [saving, setSaving] = useState(false);
  const [testResults, setTestResults] = useState<Partial<Record<AiProviderId, TestState>>>({});

  // An account with no organization yet is an onboarding state, not an error to
  // shout about on the Settings screen — every other failure gets a sentence.
  const handleAiError = useCallback(
    (err: unknown) => {
      if (err instanceof ApiError && err.noActiveOrg) return;
      setAiError(errorMessage(err, t("genericError"), te));
    },
    [t, te],
  );

  const loadAi = useCallback(() => {
    api<AiCredentialPublic[]>("/api/ai-credentials").then(setCredentials).catch(handleAiError);
    setSpendError(null);
    api<CostSummary>("/api/ai-credentials/spend")
      .then((summary) => {
        setSpend(summary);
        setSpendError(null);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.noActiveOrg) return;
        // Back to "unknown", not to a stale figure: money on screen has to be
        // either current or absent.
        setSpend(null);
        setSpendError(errorMessage(err, t("genericError"), te));
      });
  }, [handleAiError, t, te]);

  useEffect(loadAi, [loadAi]);

  function changeTheme(value: string) {
    const next = value as ThemePref;
    applyTheme(next);
    setPref(next);
  }

  async function saveKey(e: React.FormEvent) {
    e.preventDefault();
    setAiError(null);
    setSaving(true);
    // The field is omitted rather than sent empty: null in that column means
    // "use the provider's own default model", and "" is not a model id.
    const trimmedModel = defaultModel.trim();
    const body = {
      provider,
      apiKey,
      ...(trimmedModel === "" ? {} : { defaultModel: trimmedModel }),
    };
    try {
      await api("/api/ai-credentials", { method: "PUT", body: JSON.stringify(body) });
      setApiKey("");
      setDefaultModel("");
      // A new key makes every earlier verdict meaningless. Same reason the
      // server never caches a test: a green tick must always describe the key
      // that is stored right now.
      setTestResults({});
      loadAi();
    } catch (err) {
      handleAiError(err);
    } finally {
      setSaving(false);
    }
  }

  async function testKey(id: AiProviderId) {
    setTestResults((prev) => ({ ...prev, [id]: "loading" }));
    try {
      const result = await api<AiCredentialTestResult>(`/api/ai-credentials/${id}/test`, {
        method: "POST",
      });
      setTestResults((prev) => ({ ...prev, [id]: result }));
      // The test was a real, billed call — the org's spend just moved.
      loadAi();
    } catch (err) {
      // A REQUEST that failed, not a verdict — see `TestState`. Stored under its
      // own shape so the sentence is rendered as a sentence.
      setTestResults((prev) => ({
        ...prev,
        [id]: { failed: errorMessage(err, t("genericError"), te) },
      }));
    }
  }

  /**
   * Inviting someone.
   *
   * `created` is the second phase of the one modal, not a second modal: the
   * link is the only thing the product will ever show for this invitation, so
   * the screen that made it is the screen that has to hand it over. Reopening
   * Invite later cannot show it again — but re-inviting the same address
   * supersedes the old invitation and mints a fresh link, which is why nothing
   * here is stored.
   */
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ email: string; link: string; expiresAt: string } | null>(
    null,
  );
  const [copied, setCopied] = useState(false);
  const [pendingRevoke, setPendingRevoke] = useState<OrganizationInvitation | null>(null);

  /**
   * `useCallback`, and it is load-bearing rather than tidy.
   *
   * `Modal` keeps `onClose` in the dependency list of the effect that installs
   * its focus trap, and that effect's CLEANUP restores focus to whatever was
   * focused before the dialog opened. A fresh closure on every render therefore
   * re-runs the whole effect on every keystroke and yanks focus out of the email
   * field: typing "carol@example.com" into this dialog stored the letter "c".
   * Measured, not theorised — the test below reads the value back. Every other
   * modal in the app passes an inline arrow and gets away with it because none
   * of them contains a text field.
   */
  const closeInvite = useCallback(() => {
    setInviteOpen(false);
    setCreated(null);
    setInviteEmail("");
    setInviteError(null);
    setCopied(false);
  }, []);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setInviteError(null);
    // Same guard as the key form and onboarding's: an invitation is not
    // idempotent, and a double submit would mint two and leave the first one
    // superseded and confusing.
    setInviting(true);
    try {
      const result = await authClient.organization.inviteMember({
        email: inviteEmail.trim(),
        // Every member is equal in this product and every member may invite —
        // see the access control in apps/api/src/auth.ts. Sending anything else
        // here would create a role the product has no screen to see or change.
        role: "member",
      });
      if (result.error) {
        const key = result.error.code ? INVITE_FAILURE_KEYS[result.error.code] : undefined;
        setInviteError(key ? t(key) : t("genericError"));
        return;
      }
      setCreated({
        email: result.data.email,
        link: invitationLink(locale, result.data.id),
        expiresAt: String(result.data.expiresAt),
      });
      // The pending list on this card is part of the organization query.
      void refetchOrganization?.();
    } catch {
      setInviteError(t("genericError"));
    } finally {
      setInviting(false);
    }
  }

  async function copyLink(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      // No clipboard permission, or an insecure origin — a self-hosted instance
      // on plain http is exactly that. The link is rendered as selectable text
      // beside this button for that reason, so the failure costs a manual
      // selection rather than the invitation.
      setCopied(false);
    }
  }

  async function revokeInvitation(invitation: OrganizationInvitation) {
    setPendingRevoke(null);
    setInviteError(null);
    try {
      const result = await authClient.organization.cancelInvitation({
        invitationId: invitation.id,
      });
      if (result.error) {
        setInviteError(t("genericError"));
        return;
      }
      void refetchOrganization?.();
    } catch {
      setInviteError(t("genericError"));
    }
  }

  // Removing a key is one click away from unrecoverable — the secret is
  // encrypted at rest and never returned by any endpoint, so nothing on this
  // screen or in the database can put it back; the person has to go to the
  // provider for a new one. Hence a confirmation, and a `Modal` rather than
  // `confirm()` (the constitution bans native dialogs).
  const [pendingRemoval, setPendingRemoval] = useState<AiProviderId | null>(null);

  async function removeKey(id: AiProviderId) {
    setAiError(null);
    setPendingRemoval(null);
    try {
      await api(`/api/ai-credentials/${id}`, { method: "DELETE" });
      setTestResults((prev) => ({ ...prev, [id]: undefined }));
      loadAi();
    } catch (err) {
      handleAiError(err);
    }
  }

  /**
   * The three display rules of the generation-engine design's §4, rendered.
   *
   * The fourth branch is the one that matters most: a summary that is a floor of
   * exactly zero means every call we know about went unpriced, and "≥ $0.00"
   * would read as "this was free". It says so in words instead.
   */
  function costText(summary: CostSummary): string {
    if (summary.kind === "exact") return formatUsd(summary.usd);
    if (summary.kind === "approximate")
      return t("aiCostApprox", { amount: formatUsd(summary.usd) });
    if (summary.usd === 0) return t("aiCostUnknown", { count: summary.unpricedCalls });
    return t("aiCostAtLeast", {
      amount: formatUsd(summary.usd),
      count: summary.unpricedCalls,
    });
  }

  function testMeta(id: AiProviderId) {
    const result = testResults[id];
    if (result === undefined) return undefined;
    if (result === "loading") return "…";
    // The request never produced a verdict: `failed` already holds a translated
    // sentence (`errorMessage` mapped the api's code, or fell back), so it is
    // rendered, never looked up.
    if ("failed" in result) {
      return (
        <span role="alert" className="text-danger">
          {result.failed}
        </span>
      );
    }
    if (!result.ok) {
      return (
        <span role="alert" className="text-danger">
          {t(TEST_FAILURE_KEYS[result.reason], TEST_FAILURE_VALUES[result.reason])}
        </span>
      );
    }
    return t("aiTestOk", { model: result.modelId, cost: costText(result.cost) });
  }

  // Both lists ride on the organization query this card already makes
  // (`get-full-organization` returns members and invitations together), so
  // there is no second round trip and no way for the two to disagree about
  // which organization they describe.
  const members = organization?.members ?? [];
  const invitations = (organization?.invitations ?? []).filter(isLiveInvitation);

  const themeOptions = [
    { value: "system", label: t("themeSystem") },
    { value: "light", label: t("themeLight") },
    { value: "dark", label: t("themeDark") },
  ];

  return (
    <AppShell
      title={t("title")}
      primaryAction={
        <Button type="submit" form={AI_FORM_ID} disabled={saving}>
          {t("aiSave")}
        </Button>
      }
    >
      <div className="flex max-w-xl flex-col gap-4">
        <Card>
          <h2 className="mb-3 text-base font-semibold text-fg">{t("appearanceTitle")}</h2>
          <Segmented options={themeOptions} value={pref} onChange={changeTheme} />
        </Card>

        {/* Language sits beside the theme because both are preferences of the
            same kind — a small mutually-exclusive choice this person makes for
            themselves, at the constitution's one fixed location for a setting.
            It is handed the unsaved-key state because switching locale is a
            navigation, and the API key above is the one field on this screen
            no endpoint can give back. */}
        <LanguageCard hasUnsavedText={apiKey !== "" || defaultModel.trim() !== ""} />

        <Card>
          <h2 className="mb-1 text-base font-semibold text-fg">{t("aiTitle")}</h2>
          {/* Three states, three sentences. The em dash used to stand for
              "loading" AND "the request failed", and both read as "nothing
              spent". */}
          {spendError !== null ? (
            <p role="alert" className="mb-3 text-sm text-danger">
              {t("aiSpendError")}
            </p>
          ) : spend === null ? (
            <Skeleton lines={1} className="mb-3 w-48 py-1" />
          ) : (
            <p className="mb-3 text-sm text-fg-secondary">
              {t("aiSpend", { amount: costText(spend) })}
            </p>
          )}

          {aiError && (
            <p role="alert" className="mb-3 text-sm text-danger">
              {aiError}
            </p>
          )}

          {credentials === null ? (
            // Not an EmptyState: an empty state is a verdict, and we do not
            // have one yet. And not a skeleton either once the read has
            // FAILED — the sentence above is the answer, and a placeholder
            // beside it would go on claiming the list is still coming.
            aiError === null ? (
              <Skeleton lines={2} className="mb-4 py-2" />
            ) : null
          ) : credentials.length === 0 ? (
            <EmptyState title={t("aiEmpty")} className="py-6" />
          ) : (
            <div className="mb-4 overflow-hidden rounded-card border border-border">
              {credentials.map((credential) => (
                <ListRow
                  key={credential.provider}
                  title={PROVIDER_NAMES[credential.provider] ?? credential.provider}
                  meta={
                    testMeta(credential.provider) ??
                    (credential.defaultModel || t("aiProviderDefault"))
                  }
                  trailing={
                    <>
                      <Button
                        size="sm"
                        variant="secondary"
                        // Every click is a real, billed call — two physical ones
                        // when the repair retry fires — so an impatient
                        // double-click must not be charged twice.
                        disabled={testResults[credential.provider] === "loading"}
                        onClick={() => testKey(credential.provider)}
                      >
                        {t("test")}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => setPendingRemoval(credential.provider)}
                      >
                        {t("remove")}
                      </Button>
                    </>
                  }
                />
              ))}
            </div>
          )}

          <form id={AI_FORM_ID} onSubmit={saveKey} className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-3">
              <Select
                label={t("aiProviderLabel")}
                value={provider}
                onChange={(e) => setProvider(e.target.value as AiProviderId)}
                className="min-w-[160px]"
              >
                {AI_PROVIDERS.map((id) => (
                  <option key={id} value={id}>
                    {PROVIDER_NAMES[id]}
                  </option>
                ))}
              </Select>
              <Input
                type="password"
                autoComplete="off"
                label={t("aiKeyLabel")}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                required
                className="min-w-[200px] flex-1"
              />
            </div>
            {/* Constitution rule 2: the one option most people never set lives
                behind the shared disclosure, never loose on the form. */}
            <Advanced dirty={defaultModel.trim() !== ""}>
              <Input
                label={t("aiModelLabel")}
                placeholder={t("aiModelPlaceholder")}
                value={defaultModel}
                onChange={(e) => setDefaultModel(e.target.value)}
                className="w-full"
              />
            </Advanced>
          </form>
        </Card>

        <Card>
          <h2 className="mb-3 text-base font-semibold text-fg">{t("accountTitle")}</h2>
          <p className="mb-3 text-sm text-fg-secondary">{session?.user?.email}</p>
          <Button variant="secondary" onClick={() => void signOut()}>
            {tLanding("signOut")}
          </Button>
        </Card>

        {/* The workspace and its people, in one card because they are one
            subject: the constitution's one-place rule puts "who is in this
            organization" at exactly one address, and this is the address that
            already names the organization. There is no separate Members screen
            and no nav entry for one — a second location for the same setting is
            the thing the rule forbids. */}
        <Card>
          <h2 className="mb-3 text-base font-semibold text-fg">{t("workspaceTitle")}</h2>
          {/* Same rule as the credential list: "No organization" is a verdict,
              and while the query is in flight there isn't one. It used to show
              for the couple of seconds the lookup took, telling a member of an
              organization they had none. */}
          {organizationPending ? (
            <Skeleton lines={1} className="w-40 py-1" />
          ) : (
            <p className="text-sm text-fg-secondary">{organization?.name ?? t("workspaceNoOrg")}</p>
          )}

          {organization && (
            <>
              <div className="mt-4 overflow-hidden rounded-card border border-border">
                {members.map((member) => (
                  <ListRow
                    key={member.id}
                    title={member.user.email}
                    meta={
                      member.user.email === session?.user?.email ? t("peopleYou") : member.user.name
                    }
                  />
                ))}
                {invitations.map((invitation) => (
                  <ListRow
                    key={invitation.id}
                    title={invitation.email}
                    meta={t("peoplePending", {
                      expires: new Date(invitation.expiresAt).toLocaleString(locale),
                    })}
                    trailing={
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={() => setPendingRevoke(invitation)}
                      >
                        {t("remove")}
                      </Button>
                    }
                  />
                ))}
              </div>

              {inviteError && !inviteOpen && (
                <p role="alert" className="mt-3 text-sm text-danger">
                  {inviteError}
                </p>
              )}

              {/* Secondary: this screen's one primary action is the key form's
                  Save, up in the header. Two primaries on one screen is the
                  other half of the same rule. */}
              <Button
                variant="secondary"
                className="mt-3"
                onClick={() => {
                  setInviteError(null);
                  setInviteOpen(true);
                }}
              >
                {t("peopleInvite")}
              </Button>
            </>
          )}
        </Card>
      </div>

      {/* One modal, two phases: ask for the address, then hand over the link.
          A second modal for the link would let the first one close with the
          link never shown, and the link is not recoverable afterwards. */}
      <Modal
        open={inviteOpen}
        onClose={closeInvite}
        title={created === null ? t("peopleInviteTitle") : t("peopleInvitedTitle")}
        footer={
          created === null ? (
            <>
              <Button variant="secondary" onClick={closeInvite}>
                {t("peopleInviteCancel")}
              </Button>
              <Button type="submit" form={INVITE_FORM_ID} disabled={inviting}>
                {t("peopleInvite")}
              </Button>
            </>
          ) : (
            <Button variant="secondary" onClick={closeInvite}>
              {t("peopleInviteDone")}
            </Button>
          )
        }
      >
        {created === null ? (
          <form id={INVITE_FORM_ID} onSubmit={invite} className="flex flex-col gap-3">
            <p className="text-sm text-fg-secondary">{t("peopleInviteBody")}</p>
            <Input
              type="email"
              label={t("peopleEmailLabel")}
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              required
              className="w-full"
            />
            {inviteError && (
              <p role="alert" className="text-sm text-danger">
                {inviteError}
              </p>
            )}
          </form>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-fg-secondary">
              {t("peopleInviteLinkHint", {
                email: created.email,
                expires: new Date(created.expiresAt).toLocaleString(locale),
              })}
            </p>
            {/* Readable and selectable, not just copyable: `navigator.clipboard`
                is unavailable on an insecure origin, which a self-hosted
                instance on plain http is. */}
            <code className="block overflow-x-auto rounded-control border border-border bg-bg-sunken px-3 py-2 text-[13px] text-fg">
              {created.link}
            </code>
            <div>
              <Button variant="secondary" onClick={() => void copyLink(created.link)}>
                {copied ? t("peopleCopied") : t("peopleCopy")}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Revoking is destructive in the way the constitution means: the link
          already in someone's hands stops working, and nothing on this screen
          can put that link back. */}
      <Modal
        open={pendingRevoke !== null}
        onClose={() => setPendingRevoke(null)}
        title={t("peopleRevokeTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPendingRevoke(null)}>
              {t("peopleInviteCancel")}
            </Button>
            {/* Same one word as the row's button: the act has one verb. */}
            <Button
              variant="danger"
              onClick={() => pendingRevoke && void revokeInvitation(pendingRevoke)}
            >
              {t("remove")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-fg-secondary">
          {t("peopleRevokeBody", { email: pendingRevoke?.email ?? "" })}
        </p>
      </Modal>

      <Modal
        open={pendingRemoval !== null}
        onClose={() => setPendingRemoval(null)}
        title={t("aiRemoveTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setPendingRemoval(null)}>
              {t("aiRemoveCancel")}
            </Button>
            {/* Same one word as the row's button: the act has one verb. */}
            <Button variant="danger" onClick={() => pendingRemoval && removeKey(pendingRemoval)}>
              {t("remove")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-fg-secondary">
          {t("aiRemoveBody", {
            provider:
              pendingRemoval === null ? "" : (PROVIDER_NAMES[pendingRemoval] ?? pendingRemoval),
          })}
        </p>
      </Modal>
    </AppShell>
  );
}
