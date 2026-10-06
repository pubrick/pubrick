"use client";
import { useTranslations } from "next-intl";
import { use } from "react";
import { AppShell } from "@/components/app-shell";
import { InboxConversation } from "@/components/inbox-workspace";
import { authClient } from "@/lib/auth-client";
export default function InboxConversationPage({
  params,
}: {
  params: Promise<{ id: string; conversationId: string }>;
}) {
  const { id, conversationId } = use(params);
  const t = useTranslations("Inbox");
  const { data: organization } = authClient.useActiveOrganization();
  const { data: session } = authClient.useSession();
  return (
    <AppShell title={t("title")}>
      {organization && session && (
        <InboxConversation
          key={`${organization.id}:${session.user.id}:${id}:${conversationId}`}
          brandId={id}
          conversationId={conversationId}
        />
      )}
    </AppShell>
  );
}
