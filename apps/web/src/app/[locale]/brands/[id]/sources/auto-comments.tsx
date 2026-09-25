"use client";

import type { NewsCommentCollectionDto } from "@pubrick/shared";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Modal } from "@/components/ui/modal";
import { ApiError, api, errorMessage } from "@/lib/api";

export function AutoComments({
  brandId,
  telegramConnected,
}: {
  brandId: string;
  telegramConnected: boolean;
}) {
  const t = useTranslations("Sources");
  const te = useTranslations("Errors");
  const [config, setConfig] = useState<NewsCommentCollectionDto | null>(null);
  const [allowed, setAllowed] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const load = useCallback(
    (isActive: () => boolean = () => true) => {
      return api<NewsCommentCollectionDto>(`/api/sources/comment-collection?brandId=${brandId}`)
        .then((value) => {
          if (isActive()) {
            setConfig(value);
            setError(null);
          }
        })
        .catch((cause: unknown) => {
          if (!isActive()) return;
          if (cause instanceof ApiError && (cause.status === 403 || cause.status === 404))
            setAllowed(false);
          else setError(errorMessage(cause, t("autoCommentsError"), te));
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
      const next = await api<NewsCommentCollectionDto>(
        `/api/sources/comment-collection?brandId=${brandId}`,
        {
          method: "PUT",
          body: JSON.stringify({ enabled }),
        },
      );
      setConfig(next);
      setNotice(t(enabled ? "autoCommentsEnabled" : "autoCommentsDisabled"));
      setConfirm(false);
    } catch (cause) {
      setError(errorMessage(cause, t("autoCommentsError"), te));
    } finally {
      setBusy(false);
    }
  }

  if (!allowed) return null;
  if (!config)
    return error ? (
      <Card className="mb-8">
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
        <Button
          variant="secondary"
          className="mt-3"
          onClick={() => {
            setError(null);
            void load();
          }}
        >
          {t("autoCommentsRetry")}
        </Button>
      </Card>
    ) : null;
  return (
    <>
      <Card className="mb-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-prose">
            <h2 className="text-lg font-semibold text-fg">{t("autoCommentsTitle")}</h2>
            <p className="mt-1 text-sm text-fg-secondary">{t("autoCommentsDescription")}</p>
            <p className="mt-2 text-sm text-fg-secondary">{t("autoCommentsLimits")}</p>
            {!telegramConnected && (
              <p className="mt-2 text-sm text-fg-secondary">{t("autoCommentsConnection")}</p>
            )}
            <p className="mt-2 text-sm font-medium text-fg">
              {t(config.enabled ? "autoCommentsOn" : "autoCommentsOff")}
            </p>
          </div>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => (config.enabled ? void save(false) : setConfirm(true))}
          >
            {busy
              ? t("autoCommentsSaving")
              : t(config.enabled ? "autoCommentsDisable" : "autoCommentsEnable")}
          </Button>
        </div>
        {notice && (
          <p role="status" className="mt-3 text-sm text-fg-secondary">
            {notice}
          </p>
        )}
        {error && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error}
          </p>
        )}
      </Card>
      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title={t("autoCommentsConfirmTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirm(false)}>
              {t("cancel")}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => void save(true)}>
              {t("autoCommentsEnable")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-fg-secondary">{t("autoCommentsConfirmBody")}</p>
      </Modal>
    </>
  );
}
