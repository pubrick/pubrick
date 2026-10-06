"use client";
import { useTranslations } from "next-intl";
import { use } from "react";
import { AppShell } from "@/components/app-shell";
import { InboxList } from "@/components/inbox-workspace";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
export default function InboxPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations("Inbox");
  const { data: organization } = authClient.useActiveOrganization();
  const { data: session } = authClient.useSession();
  return (
    <AppShell
      title={t("title")}
      primaryAction={
        <Button
          className="min-h-11"
          type="submit"
          form="inbox-discovery"
          disabled={!organization || !session}
        >
          {t("discover")}
        </Button>
      }
    >
      {organization && session && (
        <InboxList key={`${organization.id}:${session.user.id}:${id}`} brandId={id} />
      )}
    </AppShell>
  );
}
