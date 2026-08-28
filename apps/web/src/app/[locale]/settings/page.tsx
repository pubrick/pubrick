"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Segmented } from "@/components/ui/segmented";
import { authClient } from "@/lib/auth-client";
import { applyTheme, readThemePref, type ThemePref } from "@/lib/theme";

export default function SettingsPage() {
  const t = useTranslations("SettingsPage");
  const tLanding = useTranslations("Landing");
  const { data: session } = authClient.useSession();
  const { data: organization } = authClient.useActiveOrganization();

  const [pref, setPref] = useState<ThemePref>("system");
  // Stored pref is client-only state: reading it during the first render makes
  // the SSR html (always "system") disagree with the client and React reports
  // a hydration mismatch — so sync it after mount instead.
  useEffect(() => {
    setPref(readThemePref());
  }, []);

  function changeTheme(value: string) {
    const next = value as ThemePref;
    applyTheme(next);
    setPref(next);
  }

  const themeOptions = [
    { value: "system", label: t("themeSystem") },
    { value: "light", label: t("themeLight") },
    { value: "dark", label: t("themeDark") },
  ];

  return (
    <AppShell title={t("title")}>
      <div className="flex max-w-xl flex-col gap-4">
        <Card>
          <h2 className="mb-3 text-base font-semibold text-fg">{t("appearanceTitle")}</h2>
          <Segmented options={themeOptions} value={pref} onChange={changeTheme} />
        </Card>

        <Card>
          <h2 className="mb-3 text-base font-semibold text-fg">{t("accountTitle")}</h2>
          <p className="mb-3 text-sm text-fg-secondary">{session?.user?.email}</p>
          <Button variant="secondary" onClick={() => authClient.signOut()}>
            {tLanding("signOut")}
          </Button>
        </Card>

        <Card>
          <h2 className="mb-3 text-base font-semibold text-fg">{t("workspaceTitle")}</h2>
          <p className="text-sm text-fg-secondary">{organization?.name ?? t("workspaceNoOrg")}</p>
        </Card>
      </div>
    </AppShell>
  );
}
