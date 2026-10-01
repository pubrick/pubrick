"use client";

import type { ContentType } from "@pubrick/shared";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";

export function ContentReuseConfirmation({
  open,
  onClose,
  onConfirm,
  title,
  revision,
  contentType,
  channels,
  consent,
  onConsent,
  busy,
  error,
  uncertain,
  material,
  brief,
  sourceUnavailable,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string | null;
  revision: number;
  contentType: ContentType;
  channels: readonly string[];
  consent: boolean;
  onConsent: (value: boolean) => void;
  busy: boolean;
  error: string | null;
  uncertain: boolean;
  material?: string;
  brief?: string | null;
  sourceUnavailable?: boolean;
}) {
  const t = useTranslations("Reuse");
  const tc = useTranslations("ContentNew");
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("confirmTitle")}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button onClick={onConfirm} disabled={busy || !consent}>
            {busy ? t("generating") : uncertain ? t("retry") : t("generate")}
          </Button>
        </>
      }
    >
      <dl className="space-y-3 text-sm">
        <div>
          <dt className="text-fg-secondary">{t("source")}</dt>
          <dd className="text-fg">
            {sourceUnavailable ? t("unavailable") : title?.trim() ? title : t("untitled")} ·{" "}
            {t("revision", { revision })}
          </dd>
        </div>
        <div>
          <dt className="text-fg-secondary">{tc("contentTypeLabel")}</dt>
          <dd>{tc(`contentType.${contentType}`)}</dd>
        </div>
        <div>
          <dt className="text-fg-secondary">{tc("channels")}</dt>
          <dd>{channels.join(", ")}</dd>
        </div>
      </dl>
      {material && (
        <div className="mt-4">
          <p className="text-sm font-medium">{t("material")}</p>
          <p className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap text-sm text-fg-secondary">
            {material}
          </p>
        </div>
      )}
      {brief && (
        <div className="mt-3">
          <p className="text-sm font-medium">{t("instructions")}</p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-fg-secondary">{brief}</p>
        </div>
      )}
      <p className="mt-4 text-sm text-fg-secondary">{t("confirmBody")}</p>
      <label className="mt-4 flex min-h-11 items-start gap-3 text-sm">
        <input
          type="checkbox"
          className="mt-1 h-5 w-5"
          checked={consent}
          onChange={(event) => onConsent(event.target.checked)}
          disabled={busy || uncertain}
        />
        <span>{t("consent")}</span>
      </label>
      {uncertain && (
        <p role="status" className="mt-4 text-sm text-fg-secondary">
          {t("uncertain")}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-4 text-sm text-danger">
          {error}
        </p>
      )}
    </Modal>
  );
}
