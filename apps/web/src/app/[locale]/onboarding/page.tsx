"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Logo } from "@/components/Logo";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api, errorMessage } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { orgSlug } from "@/lib/slug";

/**
 * One organization waiting for this account — the shape of
 * `GET /api/org/invitations`.
 *
 * That endpoint exists because the organization plugin's own
 * `list-user-invitations` refuses any account whose address is unverified, and
 * Pubrick verifies no addresses (there is no mailer). See
 * `apps/api/src/org/invitations.repository.ts`.
 */
type PendingInvitation = {
  id: string;
  organizationId: string;
  organizationName: string;
  inviterEmail: string;
  expiresAt: string;
};

/**
 * Where a new account lands, and — since the invitation flow shipped — the one
 * screen that turns an invitation into a membership.
 *
 * It answers three different arrivals, and the invited person is the one it was
 * rebuilt for:
 *
 * 1. **Signed out.** Previously this screen showed the create-organization form
 *    to anyone who reached its URL, including a person following an invitation
 *    link who has no account yet: they filled it in and got a 401 from an
 *    endpoint they had no session for. It now says what to do instead, and says
 *    the one thing an invited person cannot guess — that the address they
 *    register with has to be the invited one, because the signup gate admits
 *    that address and no other.
 * 2. **Signed in, with an invitation waiting.** The offer, by name, with one
 *    button. The invitation is looked up from the SESSION's own address rather
 *    than from the link, so it works whether or not the link survived the trip
 *    through sign-up — which it does not, since sign-up sends every new account
 *    here with no query of its own. `?invitation=` only picks WHICH offer to
 *    show first when there is more than one; it can never conjure one.
 * 3. **Signed in, with nothing waiting.** The original create-organization form,
 *    unchanged.
 */
export default function OnboardingPage() {
  const t = useTranslations("Onboarding");
  // The refusals' own namespace — required third argument of `errorMessage`, and
  // what puts a failed invitation lookup in the reader's language.
  const te = useTranslations("Errors");
  const locale = useLocale();
  const router = useRouter();
  const requestedInvitation = useSearchParams().get("invitation");
  const { data: session, isPending: sessionPending } = authClient.useSession();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Creating an organization is not idempotent: the same name submitted twice
  // makes two rows, one of which wins `setActive` while the other becomes an
  // org the person owns and has no screen to find. `disabled` on the submit is
  // the guard — a click is a discrete React event, so this state has already
  // flushed to the DOM before an impatient second click can be dispatched, and
  // a disabled submit also takes Enter-in-the-field with it. Same mechanism as
  // AuthForm's; onboarding was simply missing it. Accepting an invitation is
  // guarded by the same flag for the same reason.
  const [busy, setBusy] = useState(false);

  // `null` is "not asked yet", NOT "none" — the same distinction the Settings
  // screen draws for its credential list. Guessing "none" would show an invited
  // person the create-a-workspace form for as long as the lookup takes, which is
  // the exact wrong instruction.
  const [invitations, setInvitations] = useState<PendingInvitation[] | null>(null);
  const [invitationsError, setInvitationsError] = useState<string | null>(null);
  /** Set by the "create one instead" escape hatch, so an offer can be declined. */
  const [creatingInstead, setCreatingInstead] = useState(false);

  const userId = session?.user?.id ?? null;
  useEffect(() => {
    if (userId === null) return;
    let live = true;
    api<PendingInvitation[]>("/api/org/invitations")
      .then((rows) => {
        if (!live) return;
        setInvitations(rows);
        setInvitationsError(null);
      })
      .catch((err) => {
        if (!live) return;
        // The form is still offered — an account with no organization needs SOME
        // way forward — but not silently: a person who was invited and is being
        // shown "create your organization" has to know the check failed, or they
        // will create a second workspace nobody else is in.
        setInvitations([]);
        setInvitationsError(errorMessage(err, t("genericError"), te));
      });
    return () => {
      live = false;
    };
  }, [userId, t, te]);

  const offer =
    invitations?.find((invitation) => invitation.id === requestedInvitation) ??
    invitations?.[0] ??
    null;

  async function join(invitation: PendingInvitation) {
    setBusy(true);
    setError(null);
    const accepted = await authClient.organization.acceptInvitation({
      invitationId: invitation.id,
    });
    if (accepted.error) {
      // Never the library's own English sentence: an invitation that has been
      // revoked, spent or has expired all arrive here, and all of them mean the
      // same thing to the reader — this one will not open the door, ask for
      // another.
      setError(t("joinFailed"));
      setBusy(false);
      return;
    }
    // `accept-invitation` sets the active organization server-side, but the
    // client's session store is a separate copy of that fact. Setting it
    // explicitly is the same insurance the create path takes, and for the same
    // reason: without an active organization every org-scoped route 403s, so a
    // failure has to stop here rather than bounce the person into a broken page.
    const activated = await authClient.organization.setActive({
      organizationId: invitation.organizationId,
    });
    if (activated.error) {
      setError(activated.error.message ?? t("genericError"));
      setBusy(false);
      return;
    }
    // Deliberately still busy — see the create path below.
    router.push(`/${locale}/brands`);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const slug = orgSlug(name);
    const created = await authClient.organization.create({ name, slug });
    if (created.error) {
      setError(created.error.message ?? t("genericError"));
      setBusy(false);
      return;
    }
    // Without an active organization every org-scoped route 403s, so a failed
    // setActive must stop here rather than bounce the user into a broken page.
    const activated = await authClient.organization.setActive({
      organizationId: created.data.id,
    });
    if (activated.error) {
      setError(activated.error.message ?? t("genericError"));
      setBusy(false);
      return;
    }
    // Deliberately still busy: the org exists, and the only thing left is a
    // navigation. Re-enabling here would reopen the double-create window for
    // the length of the route transition.
    router.push(`/${locale}/brands`);
  }

  function body() {
    // Nothing decided yet. Not the form: a signed-in person would see "create
    // your organization" flash before the offer they were sent here for.
    if (sessionPending) return <Skeleton lines={3} className="py-2" />;

    if (!session) {
      return (
        <div className="flex flex-col gap-4">
          <div>
            <h1 className="text-xl font-semibold text-fg">{t("signedOutTitle")}</h1>
            <p className="mt-1 text-sm text-fg-secondary">{t("signedOutBody")}</p>
          </div>
          {/* A real <Link>, wearing the design system's own primary classes via
              `buttonClasses` rather than a hand-copied list of them — the
              landing page keeps such a copy and says in a comment that it has
              to be re-synced by hand. This is a navigation, not an action. */}
          <Link href={`/${locale}/signup`} className={buttonClasses("primary", "md", "w-full")}>
            {t("signedOutAction")}
          </Link>
        </div>
      );
    }

    if (invitations === null) return <Skeleton lines={3} className="py-2" />;

    if (offer !== null && !creatingInstead) {
      return (
        <div className="flex flex-col gap-4">
          <div>
            <h1 className="text-xl font-semibold text-fg">
              {t("invitedTitle", { organization: offer.organizationName })}
            </h1>
            <p className="mt-1 text-sm text-fg-secondary">
              {t("invitedSubtitle", { inviter: offer.inviterEmail })}
            </p>
          </div>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          <Button type="button" disabled={busy} className="w-full" onClick={() => void join(offer)}>
            {t("invitedJoin")}
          </Button>
          {/* Secondary, and a real escape hatch: an account can be invited
              somewhere and still want a workspace of its own. */}
          <Button
            type="button"
            variant="ghost"
            className="w-full"
            onClick={() => setCreatingInstead(true)}
          >
            {t("invitedCreateInstead")}
          </Button>
        </div>
      );
    }

    return (
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div>
          <h1 className="text-xl font-semibold text-fg">{t("title")}</h1>
          <p className="mt-1 text-sm text-fg-secondary">{t("subtitle")}</p>
        </div>
        {invitationsError && (
          <p role="alert" className="text-sm text-danger">
            {t("invitationsUnchecked", { reason: invitationsError })}
          </p>
        )}
        <Input
          label={t("orgName")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          minLength={1}
        />
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy} className="w-full">
          {t("create")}
        </Button>
      </form>
    );
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-bg-sunken px-4">
      <Logo width={160} />
      <Card padded={false} className="w-full max-w-[400px] p-8">
        {body()}
      </Card>
    </main>
  );
}
