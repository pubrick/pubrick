"use client";

import { contentReuseResultSchema } from "@pubrick/shared";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api, errorMessage } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import {
  getPendingContentReuse,
  type PendingContentReuse,
  type ReuseIdentity,
  settlePendingContentReuse,
} from "@/lib/pending-content-reuse";

export function useReuseIdentity(): ReuseIdentity | null {
  const { data: session, isPending: sessionPending } = authClient.useSession();
  const { data: organization, isPending: organizationPending } = authClient.useActiveOrganization();
  return !sessionPending && !organizationPending && session?.user.id && organization?.id
    ? { userId: session.user.id, orgId: organization.id }
    : null;
}

/** Pending recovery precedes all resource reads, including a deleted source/run. */
export function ContentReuseRecoveryBoundary({
  operation,
  targetId,
  children,
}: {
  operation: PendingContentReuse["operation"];
  targetId: string;
  children: ReactNode;
}) {
  const identity = useReuseIdentity();
  const { data: session, isPending: sessionPending } = authClient.useSession();
  const { data: organization, isPending: organizationPending } = authClient.useActiveOrganization();
  const router = useRouter();
  const locale = useLocale();
  const t = useTranslations("Reuse");
  useEffect(() => {
    if (!sessionPending && !organizationPending && session?.user.id && !organization?.id)
      router.replace(`/${locale}/onboarding`);
  }, [sessionPending, organizationPending, session?.user.id, organization?.id, router, locale]);
  if (!identity) return <AppShell title={t("title")}>{null}</AppShell>;
  const request = identity ? getPendingContentReuse(identity, operation, targetId) : null;
  return request && identity ? (
    <PendingRecovery
      key={JSON.stringify([identity.userId, identity.orgId, operation, targetId])}
      identity={identity}
      request={request}
    />
  ) : (
    <Fragment key={JSON.stringify([identity?.userId, identity?.orgId, operation, targetId])}>
      {children}
    </Fragment>
  );
}

function PendingRecovery({
  identity,
  request,
}: {
  identity: ReuseIdentity;
  request: PendingContentReuse;
}) {
  const t = useTranslations("Reuse");
  const tc = useTranslations("ContentNew");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const recover = async () => {
    if (inFlight.current || complete) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const path =
        request.operation === "reuse"
          ? `/api/content/${request.targetId}/reuse`
          : `/api/runs/${request.targetId}/retry`;
      const result = contentReuseResultSchema.parse(
        await api(path, {
          method: "POST",
          headers: { "Idempotency-Key": request.key },
          body: JSON.stringify(request.body),
        }),
      );
      settlePendingContentReuse(identity, request.operation, request.targetId, request.key);
      if (!mounted.current) return;
      setComplete(true);
      router.push(`/${locale}/content/runs/${result.id}`);
    } catch (err) {
      setError(errorMessage(err, tc("genericError"), te));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <AppShell
      title={t("title")}
      primaryAction={
        <Button disabled={busy || complete} onClick={() => void recover()}>
          {busy ? t("generating") : t("retry")}
        </Button>
      }
    >
      <Card className="max-w-2xl">
        <p role="status" className="text-sm text-fg-secondary">
          {t("recovery")}
        </p>
        {request.operation === "reuse" && (
          <p className="mt-3 text-sm text-fg-secondary">
            {t("revision", { revision: request.body.expectedSourceRevision })} ·{" "}
            {tc(`contentType.${request.body.contentType}`)}
          </p>
        )}
        {error && (
          <p role="alert" className="mt-4 text-sm text-danger">
            {error}
          </p>
        )}
      </Card>
    </AppShell>
  );
}
