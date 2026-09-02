"use client";

import { useRouter } from "next/navigation";
import { useLocale } from "next-intl";
import { useCallback } from "react";
import { authClient } from "@/lib/auth-client";
import { loginHref } from "@/lib/auth-routes";

/**
 * Sign out, then leave.
 *
 * `authClient.signOut()` only drops the cookie and the client's session store;
 * on its own it leaves the person exactly where they were, looking at a screen
 * still painted with their organization's data — which is how "Sign out" came
 * to be a button that visibly did nothing on a shared computer. The navigation
 * is therefore part of the act, not a per-screen afterthought: three call sites
 * (the shell's user menu, Settings, the landing page) share this one hook so
 * they cannot drift.
 *
 * `replace`, not `push`: the page they just left must not be one Back away.
 *
 * No `next` is attached. AppShell's own guard, racing this one on the same
 * session update, may still add one for the page it was rendering — harmless,
 * since both land on the login screen and the worst case is a re-authenticated
 * user returning to the page they were on.
 */
export function useSignOut(): () => Promise<void> {
  const router = useRouter();
  const locale = useLocale();

  return useCallback(async () => {
    await authClient.signOut();
    router.replace(loginHref(locale));
  }, [router, locale]);
}
