"use client";

import {
  type LinkedInConnection,
  linkedinAuthorizationStartSchema,
  linkedinDisconnectSchema,
} from "@pubrick/shared";
import { useLocale, useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { api, apiVoid, errorMessage } from "@/lib/api";
import { openLinkedInAuthorization } from "@/lib/linkedin";
import { Button } from "./ui/button";
import { Modal } from "./ui/modal";
import { StatusBadge } from "./ui/status-badge";

export function LinkedInConnectionSummary({
  connection,
}: {
  connection?: LinkedInConnection | null;
}) {
  const t = useTranslations("LinkedIn");
  const locale = useLocale();
  if (!connection) return <span>{t("states.reconnect")}</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <StatusBadge
        status={
          connection.state === "connected"
            ? "published"
            : connection.state === "disconnected"
              ? "draft"
              : "review"
        }
      >
        {t(`states.${connection.state}`)}
      </StatusBadge>
      {connection.account && <span>{connection.account}</span>}
      {connection.expiresAt && connection.state !== "disconnected" && (
        <span>
          {t("expires", {
            date: new Intl.DateTimeFormat(locale, {
              dateStyle: "medium",
              timeStyle: "short",
            }).format(new Date(connection.expiresAt)),
          })}
        </span>
      )}
      <span>{t("capability")}</span>
    </span>
  );
}

export function LinkedInConnectionActions({
  brandId,
  channel,
  onChanged,
}: {
  brandId: string;
  channel: { id: string; name: string; connection?: LinkedInConnection | null };
  onChanged: () => void;
}) {
  const t = useTranslations("LinkedIn");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const generation = channel.connection?.generation;
  async function reconnect() {
    if (busyRef.current || generation === undefined) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const body = linkedinAuthorizationStartSchema.parse({
        brandId,
        name: channel.name,
        locale,
        channelId: channel.id,
        expectedGeneration: generation,
      });
      openLinkedInAuthorization(
        await api("/api/channels/linkedin/authorize", {
          method: "POST",
          body: JSON.stringify(body),
        }),
      );
    } catch (caught) {
      setError(errorMessage(caught, t("genericError"), te));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function disconnect() {
    if (busyRef.current || generation === undefined) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await apiVoid(`/api/channels/linkedin/${channel.id}/disconnect`, {
        method: "POST",
        body: JSON.stringify(linkedinDisconnectSchema.parse({ expectedGeneration: generation })),
      });
      setOpen(false);
      onChanged();
    } catch (caught) {
      setError(errorMessage(caught, t("genericError"), te));
    } finally {
      busyRef.current = false;
      setBusy(false);
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
            setOpen(true);
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
      <Modal
        open={open}
        onClose={() => {
          if (!busyRef.current) setOpen(false);
        }}
        title={t("disconnectTitle")}
        footer={
          <>
            <Button
              className="min-h-11"
              variant="secondary"
              disabled={busy}
              onClick={() => setOpen(false)}
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
