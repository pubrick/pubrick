"use client";

import type { PublicationCommentCollectionDto } from "@pubrick/shared";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Modal } from "@/components/ui/modal";
import { api, errorMessage } from "@/lib/api";

export function AutoReplies({ brandId }: { brandId: string }) {
  const t = useTranslations("Analytics");
  const te = useTranslations("Errors");
  const [config, setConfig] = useState<PublicationCommentCollectionDto | null>(null);
  const [connectionState, setConnectionState] = useState<
    "checking" | "connected" | "disconnected" | "unknown"
  >("checking");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(
    (active: () => boolean = () => true) => {
      setConnectionState("checking");
      void api<{ connected: boolean }>("/api/sources/telegram-connection")
        .then((connection) => {
          if (active()) setConnectionState(connection.connected ? "connected" : "disconnected");
        })
        .catch(() => {
          if (active()) setConnectionState("unknown");
        });
      return api<PublicationCommentCollectionDto>(
        `/api/analytics/brands/${brandId}/comment-collection`,
      )
        .then((next) => {
          if (!active()) return;
          setConfig(next);
          setError(null);
        })
        .catch((cause) => {
          if (active()) setError(errorMessage(cause, t("autoRepliesError"), te));
        });
    },
    [brandId, t, te],
  );

  useEffect(() => {
    let active = true;
    void load(() => active);
    return () => {
      active = false;
    };
  }, [load]);

  async function save(enabled: boolean) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await api<PublicationCommentCollectionDto>(
        `/api/analytics/brands/${brandId}/comment-collection`,
        { method: "PUT", body: JSON.stringify({ enabled }) },
      );
      setConfig(next);
      setNotice(t(enabled ? "autoRepliesEnabled" : "autoRepliesDisabled"));
      setConfirm(false);
    } catch (cause) {
      setError(errorMessage(cause, t("autoRepliesError"), te));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-prose">
            <h2 className="text-lg font-semibold text-fg">{t("autoRepliesTitle")}</h2>
            <p className="mt-1 text-sm text-fg-secondary">{t("autoRepliesDescription")}</p>
            <p className="mt-2 text-sm text-fg-secondary">{t("autoRepliesLimits")}</p>
            {config && (
              <p className="mt-2 text-sm font-medium text-fg">
                {t(config.enabled ? "autoRepliesOn" : "autoRepliesOff")}
              </p>
            )}
            {config && connectionState === "disconnected" && (
              <p className="mt-2 text-sm text-fg-secondary">
                {t(config.enabled ? "autoRepliesWaitingConnection" : "autoRepliesConnection")}
              </p>
            )}
            {config && connectionState === "unknown" && (
              <p className="mt-2 text-sm text-fg-secondary">{t("autoRepliesConnectionUnknown")}</p>
            )}
          </div>
          {config && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => (config.enabled ? void save(false) : setConfirm(true))}
            >
              {busy
                ? t("autoRepliesSaving")
                : t(config.enabled ? "autoRepliesDisable" : "autoRepliesEnable")}
            </Button>
          )}
        </div>
        {notice && (
          <p role="status" className="mt-3 text-sm text-fg-secondary">
            {notice}
          </p>
        )}
        {error && (
          <div role="alert" className="mt-3 flex items-center gap-3 text-sm text-danger">
            <span>{error}</span>
            {!config && (
              <Button variant="secondary" onClick={() => void load()}>
                {t("autoRepliesRetry")}
              </Button>
            )}
          </div>
        )}
      </Card>
      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title={t("autoRepliesConfirmTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirm(false)}>
              {t("autoRepliesCancel")}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => void save(true)}>
              {t("autoRepliesEnable")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-fg-secondary">{t("autoRepliesConfirmBody")}</p>
      </Modal>
    </>
  );
}
