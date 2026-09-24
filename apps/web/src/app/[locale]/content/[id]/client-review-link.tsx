"use client";

import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api, apiVoid, errorMessage } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

type LinkStatus = {
  status: "none" | "pending" | "approved" | "changes_requested" | "expired" | "revoked" | "stale";
  expiresAt: string | null;
  reviewedAt: string | null;
  comment: string | null;
};
type CreatedLink = { token: string; expiresAt: string; status: "pending" };
const LINK_STATUSES: readonly LinkStatus["status"][] = [
  "none",
  "pending",
  "approved",
  "changes_requested",
  "expired",
  "revoked",
  "stale",
];

export function ClientReviewLink({
  itemId,
  revision,
  canCreate,
}: {
  itemId: string;
  revision: string;
  canCreate: boolean;
}) {
  const t = useTranslations("ClientReviewLink");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const { data: session } = authClient.useSession();
  const { data: organization } = authClient.useActiveOrganization();
  const member = organization?.members?.find(
    (entry) => entry.userId === session?.user.id || entry.user?.id === session?.user.id,
  );
  const canManage = member?.role === "owner" || member?.role === "admin";
  const [status, setStatus] = useState<LinkStatus | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endpoint = `/api/content/${itemId}/client-review-link`;

  const load = useCallback(async () => {
    try {
      const result = await api<LinkStatus>(endpoint, { cache: "no-store" });
      if (!result || !LINK_STATUSES.includes(result.status))
        throw new Error("invalid review status");
      setStatus(result);
      if (result.status !== "pending") setLink(null);
      setError(null);
    } catch (err) {
      setError(errorMessage(err, t("error"), te));
    }
  }, [endpoint, t, te]);

  useEffect(() => {
    setLink(null);
    setCopied(false);
    // A changed draft closes the one-time URL even when the content ID stays the same.
    void revision;
    void load();
  }, [load, revision]);

  async function create() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setLink(null);
    try {
      const created = await api<CreatedLink>(endpoint, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setStatus({
        status: "pending",
        expiresAt: created.expiresAt,
        reviewedAt: null,
        comment: null,
      });
      setLink(`${window.location.origin}/${locale}/review/${encodeURIComponent(created.token)}`);
      setCopied(false);
    } catch (err) {
      setError(errorMessage(err, t("error"), te));
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiVoid(endpoint, { method: "DELETE" });
      setStatus({ status: "revoked", expiresAt: null, reviewedAt: null, comment: null });
      setLink(null);
      setCopied(false);
    } catch (err) {
      setError(errorMessage(err, t("error"), te));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setError(t("copyFailed"));
    }
  }

  return (
    <Card className="mb-6" aria-label={t("title")}>
      <h2 className="text-lg font-semibold text-fg">{t("title")}</h2>
      <p className="mt-1 text-sm text-fg-secondary">{t("hint")}</p>
      {status ? (
        <p className="mt-3 text-sm text-fg" role="status">
          {t(`status.${status.status}`)}
          {status.expiresAt && status.status === "pending" && (
            <> · {t("expires", { date: new Date(status.expiresAt).toLocaleString(locale) })}</>
          )}
        </p>
      ) : !error ? (
        <p className="mt-3 text-sm text-fg-secondary">{t("loading")}</p>
      ) : null}
      {status?.comment && (
        <div className="mt-3 rounded-control border border-border bg-bg-sunken p-3">
          <p className="text-xs font-medium text-fg-secondary">{t("clientComment")}</p>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-fg">{status.comment}</p>
        </div>
      )}
      {status && !["none", "revoked", "approved"].includes(status.status) && (
        <p className="mt-2 text-sm text-fg-secondary">{t("approvalGateHint")}</p>
      )}
      {link && (
        <div className="mt-3 rounded-control border border-border bg-bg-sunken p-3">
          <p className="text-sm text-fg-secondary">{t("oneTimeHint")}</p>
          <p className="mt-2 break-all text-sm text-fg" data-testid="client-review-link">
            {link}
          </p>
          <Button className="mt-3 min-h-11" variant="secondary" onClick={() => void copy()}>
            {copied ? t("copied") : t("copy")}
          </Button>
        </div>
      )}
      {error && (
        <p className="mt-3 text-sm text-danger" role="alert">
          {error}
        </p>
      )}
      {error && !status && (
        <Button className="mt-3 min-h-11" variant="secondary" onClick={() => void load()}>
          {t("retry")}
        </Button>
      )}
      {canManage && status && (canCreate || !["none", "revoked"].includes(status.status)) && (
        <div className="mt-4 flex flex-wrap gap-2">
          {canCreate && (
            <Button
              className="min-h-11"
              variant="secondary"
              disabled={busy}
              onClick={() => void create()}
            >
              {status.status === "none" || status.status === "revoked" ? t("create") : t("replace")}
            </Button>
          )}
          {status.status !== "none" && status.status !== "revoked" && (
            <Button
              className="min-h-11"
              variant="danger"
              disabled={busy}
              onClick={() => void revoke()}
            >
              {t("revoke")}
            </Button>
          )}
        </div>
      )}
      {status && status.status !== "none" && status.status !== "revoked" && (
        <Button
          className="mt-3 min-h-11"
          variant="ghost"
          disabled={busy}
          onClick={() => void load()}
        >
          {t("refresh")}
        </Button>
      )}
      {status && status.status !== "none" && status.status !== "revoked" && (
        <p className="mt-3 text-xs text-fg-tertiary">{t("identityHint")}</p>
      )}
    </Card>
  );
}
