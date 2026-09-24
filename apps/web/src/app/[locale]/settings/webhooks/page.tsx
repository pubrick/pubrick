"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Advanced } from "@/components/ui/advanced";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { ListRow } from "@/components/ui/list-row";
import { Modal } from "@/components/ui/modal";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { ApiError, api, apiVoid, errorMessage } from "@/lib/api";

type Subscription = {
  id: string;
  name: string;
  onSucceeded: boolean;
  onFailed: boolean;
  onUnknown: boolean;
  createdAt: string;
};
type Delivery = {
  id: string;
  subscriptionId: string;
  publicationId: string;
  event: "publication.succeeded" | "publication.failed" | "publication.unknown";
  status: "pending" | "attempting" | "sent" | "failed" | "unknown";
  attempts: number;
  lastHttpStatus: number | null;
  createdAt: string;
};

const FORM_ID = "webhook-create-form";

export default function WebhooksPage() {
  const t = useTranslations("Webhooks");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const [subscriptions, setSubscriptions] = useState<Subscription[] | null>(null);
  const [deliveries, setDeliveries] = useState<Delivery[] | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [onSucceeded, setOnSucceeded] = useState(true);
  const [onFailed, setOnFailed] = useState(true);
  const [onUnknown, setOnUnknown] = useState(true);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const [nextSubscriptions, nextDeliveries] = await Promise.all([
        api<Subscription[]>("/api/webhooks"),
        api<Delivery[]>("/api/webhooks/deliveries"),
      ]);
      setSubscriptions(nextSubscriptions);
      setDeliveries(nextDeliveries);
      setDenied(false);
      setError(null);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 403) {
        setDenied(true);
        return;
      }
      setError(errorMessage(cause, t("genericError"), te));
    }
  }, [t, te]);
  useEffect(() => {
    void load();
  }, [load]);

  const closeCreate = useCallback(() => {
    setCreating(false);
    setSecret(null);
    setCopied(false);
  }, []);
  const closeRevoke = useCallback(() => setRevokeId(null), []);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!onSucceeded && !onFailed && !onUnknown) {
      setError(t("chooseEvent"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await api<{ secret: string }>("/api/webhooks", {
        method: "POST",
        body: JSON.stringify({ name, url, onSucceeded, onFailed, onUnknown }),
      });
      setSecret(created.secret);
      setName("");
      setUrl("");
      setOnSucceeded(true);
      setOnFailed(true);
      setOnUnknown(true);
      await load();
    } catch (cause) {
      setError(errorMessage(cause, t("genericError"), te));
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!revokeId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiVoid(`/api/webhooks/${revokeId}`, { method: "DELETE" });
      setRevokeId(null);
      await load();
    } catch (cause) {
      setError(errorMessage(cause, t("genericError"), te));
    } finally {
      setBusy(false);
    }
  }

  const eventLabel = (event: Delivery["event"]) =>
    event === "publication.succeeded"
      ? t("succeeded")
      : event === "publication.failed"
        ? t("failed")
        : t("unknown");
  const statusLabel = (status: Delivery["status"]) =>
    status === "pending"
      ? t("pending")
      : status === "attempting"
        ? t("attempting")
        : status === "sent"
          ? t("sent")
          : status === "failed"
            ? t("failed")
            : t("unknown");
  const statusColor = (status: Delivery["status"]) =>
    status === "sent"
      ? ("published" as const)
      : status === "failed"
        ? ("failed" as const)
        : status === "unknown"
          ? ("review" as const)
          : ("scheduled" as const);

  return (
    <AppShell
      title={t("title")}
      primaryAction={
        denied ? undefined : (
          <Button
            disabled={subscriptions === null || subscriptions.length >= 10}
            onClick={() => {
              setError(null);
              setCreating(true);
            }}
          >
            {t("add")}
          </Button>
        )
      }
    >
      <div className="flex max-w-2xl flex-col gap-4">
        <Link href={`/${locale}/settings`} className="text-sm text-accent underline">
          {t("back")}
        </Link>
        <Card>
          <h2 className="mb-2 text-base font-semibold text-fg">{t("title")}</h2>
          <p className="text-sm text-fg-secondary">{t("hint")}</p>
          {subscriptions && (
            <p className="mt-2 text-sm text-fg-tertiary">
              {t("limit", { count: subscriptions.length })}
            </p>
          )}
          {error && (
            <p role="alert" className="mt-3 text-sm text-danger">
              {error}
            </p>
          )}
        </Card>
        {denied ? (
          <Card>
            <p role="alert" className="text-sm text-fg-secondary">
              {t("ownerOnly")}
            </p>
          </Card>
        ) : subscriptions === null ? (
          <Card>
            {error ? (
              <Button variant="secondary" onClick={() => void load()}>
                {t("retry")}
              </Button>
            ) : (
              <Skeleton lines={3} />
            )}
          </Card>
        ) : subscriptions.length === 0 ? (
          <EmptyState
            title={t("emptyTitle")}
            action={<p className="text-sm text-fg-tertiary">{t("emptyHint")}</p>}
          />
        ) : (
          <Card padded={false}>
            {subscriptions.map((item) => (
              <ListRow
                key={item.id}
                title={item.name}
                meta={t("eventsCount", {
                  count: Number(item.onSucceeded) + Number(item.onFailed) + Number(item.onUnknown),
                })}
                trailing={
                  <Button size="sm" variant="danger" onClick={() => setRevokeId(item.id)}>
                    {t("revoke")}
                  </Button>
                }
              />
            ))}
          </Card>
        )}
        {!denied && (
          <Card>
            <h2 className="mb-2 text-base font-semibold text-fg">{t("history")}</h2>
            <p className="mb-3 text-sm text-fg-secondary">{t("historyHint")}</p>
            {deliveries === null ? (
              <Skeleton lines={2} />
            ) : deliveries.length === 0 ? (
              <p className="text-sm text-fg-tertiary">{t("historyEmpty")}</p>
            ) : (
              <div className="overflow-hidden rounded-card border border-border">
                {deliveries.map((delivery) => (
                  <ListRow
                    key={delivery.id}
                    title={eventLabel(delivery.event)}
                    meta={`${delivery.id} · ${t("attempts", { count: delivery.attempts })}${delivery.lastHttpStatus ? ` · HTTP ${delivery.lastHttpStatus}` : ""}`}
                    trailing={
                      <StatusBadge status={statusColor(delivery.status)}>
                        {statusLabel(delivery.status)}
                      </StatusBadge>
                    }
                  />
                ))}
              </div>
            )}
          </Card>
        )}
      </div>
      <Modal
        open={creating}
        onClose={closeCreate}
        title={secret ? t("createdTitle") : t("createTitle")}
        footer={
          secret ? (
            <Button onClick={closeCreate}>{t("done")}</Button>
          ) : (
            <>
              <Button variant="secondary" onClick={closeCreate}>
                {t("cancel")}
              </Button>
              <Button type="submit" form={FORM_ID} disabled={busy}>
                {t("add")}
              </Button>
            </>
          )
        }
      >
        {secret ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-fg-secondary">{t("oneTimeHint")}</p>
            <code className="break-all rounded-control border border-border bg-bg-sunken p-3 text-sm text-fg">
              {secret}
            </code>
            <Button
              variant="secondary"
              onClick={() =>
                void navigator.clipboard
                  .writeText(secret)
                  .then(() => setCopied(true))
                  .catch(() => setError(t("copyFailed")))
              }
            >
              {copied ? t("copied") : t("copy")}
            </Button>
            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
          </div>
        ) : (
          <form id={FORM_ID} onSubmit={create} className="flex flex-col gap-3">
            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
            <Input
              label={t("name")}
              value={name}
              maxLength={80}
              required
              autoFocus
              onChange={(event) => setName(event.target.value)}
            />
            <Input
              label={t("url")}
              type="url"
              value={url}
              maxLength={2048}
              required
              placeholder="https://hooks.example.com/pubrick"
              onChange={(event) => setUrl(event.target.value)}
            />
            <Advanced dirty={!onSucceeded || !onFailed || !onUnknown} label={t("events")}>
              <div className="flex flex-col gap-3 text-sm text-fg-secondary">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={onSucceeded}
                    onChange={(event) => setOnSucceeded(event.target.checked)}
                  />
                  {t("succeeded")}
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={onFailed}
                    onChange={(event) => setOnFailed(event.target.checked)}
                  />
                  {t("failed")}
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={onUnknown}
                    onChange={(event) => setOnUnknown(event.target.checked)}
                  />
                  {t("unknown")}
                </label>
              </div>
            </Advanced>
          </form>
        )}
      </Modal>
      <Modal
        open={revokeId !== null}
        onClose={closeRevoke}
        title={t("revokeTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={closeRevoke}>
              {t("cancel")}
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => void revoke()}>
              {t("revoke")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-fg-secondary">{t("revokeHint")}</p>
      </Modal>
    </AppShell>
  );
}
