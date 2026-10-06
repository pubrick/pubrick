"use client";

import {
  type MetaConnection,
  type MetaConnectionProvider,
  metaAuthorizationStartSchema,
  metaDisconnectSchema,
} from "@pubrick/shared";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { api, apiVoid, errorMessage } from "@/lib/api";
import { openMetaAuthorization } from "@/lib/meta-connections";
import { Button } from "./ui/button";
import { Modal } from "./ui/modal";
import { StatusBadge } from "./ui/status-badge";

export function MetaConnectionSummary({
  provider,
  connection,
}: {
  provider: MetaConnectionProvider;
  connection?: MetaConnection | null;
}) {
  const t = useTranslations("MetaConnections");
  const locale = useLocale();
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <StatusBadge
        status={
          connection?.state === "connected"
            ? "published"
            : connection?.state === "disconnected"
              ? "draft"
              : "review"
        }
      >
        {t(`states.${connection?.state ?? "reconnect"}`)}
      </StatusBadge>
      {connection?.account && <span>{connection.account}</span>}
      {connection?.expiresAt && connection.state !== "disconnected" && (
        <span>
          {t("expires", {
            date: new Intl.DateTimeFormat(locale, {
              dateStyle: "medium",
              timeStyle: "short",
            }).format(new Date(connection.expiresAt)),
          })}
        </span>
      )}
      <span>{t(`capability.${provider}`)}</span>
    </span>
  );
}

export function MetaConnectionActions({
  brandId,
  provider,
  channel,
  onChanged,
}: {
  brandId: string;
  provider: MetaConnectionProvider;
  channel: { id: string; name: string; connection?: MetaConnection | null };
  onChanged: () => void;
}) {
  const t = useTranslations("MetaConnections");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const [confirmationScope, setConfirmationScope] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const generation = channel.connection?.generation;
  const mounted = useRef(true);
  const scope = `${brandId}/${provider}/${channel.id}/${generation}`;
  const open = confirmationScope === scope;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  useEffect(() => {
    setConfirmationScope((confirmed) => (confirmed === scope ? confirmed : null));
  }, [scope]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function reconnect() {
    if (busyRef.current || generation === undefined) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const body = metaAuthorizationStartSchema.parse({
        provider,
        brandId,
        name: channel.name,
        locale,
        channelId: channel.id,
        expectedGeneration: generation,
      });
      const result = await api("/api/channels/meta/authorize", {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (mounted.current && currentScope.current === scope)
        openMetaAuthorization(provider, result);
    } catch (caught) {
      if (mounted.current && currentScope.current === scope)
        setError(errorMessage(caught, t("genericError"), te));
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function disconnect() {
    if (busyRef.current || generation === undefined || confirmationScope !== scope) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await apiVoid(`/api/channels/meta/${channel.id}/disconnect`, {
        method: "POST",
        body: JSON.stringify(metaDisconnectSchema.parse({ expectedGeneration: generation })),
      });
      if (mounted.current && currentScope.current === scope) {
        setConfirmationScope(null);
        onChanged();
      }
    } catch (caught) {
      if (mounted.current && currentScope.current === scope)
        setError(errorMessage(caught, t("genericError"), te));
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <>
      <Button
        className="min-h-11"
        size="sm"
        variant="secondary"
        disabled={busy || generation === undefined}
        onClick={reconnect}
      >
        {busy ? t("working") : t("reconnect")}
      </Button>
      {channel.connection?.state !== "disconnected" && (
        <Button
          className="min-h-11"
          size="sm"
          variant="danger"
          disabled={busy || generation === undefined}
          onClick={() => {
            setError(null);
            setConfirmationScope(scope);
          }}
        >
          {t("disconnect")}
        </Button>
      )}
      {error && !open && (
        <span role="alert" className="text-sm text-danger">
          {error}
        </span>
      )}
      {generation === undefined && (
        <span className="text-sm text-fg-secondary">
          {t("reloadRequired")}
          <Button className="ml-2 min-h-11" size="sm" variant="secondary" onClick={onChanged}>
            {t("reload")}
          </Button>
        </span>
      )}
      <Modal
        open={open}
        onClose={() => {
          if (!busyRef.current) setConfirmationScope(null);
        }}
        title={t("disconnectTitle")}
        footer={
          <>
            <Button
              className="min-h-11"
              variant="secondary"
              disabled={busy}
              onClick={() => setConfirmationScope(null)}
            >
              {t("cancel")}
            </Button>
            <Button className="min-h-11" variant="danger" disabled={busy} onClick={disconnect}>
              {busy ? t("working") : t("disconnect")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-fg-secondary">{t("disconnectBody", { name: channel.name })}</p>
        {error && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error}
          </p>
        )}
      </Modal>
    </>
  );
}
