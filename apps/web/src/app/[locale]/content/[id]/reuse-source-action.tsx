"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";

/** Navigation never submits a generation request; Save must establish a persisted source first. */
export function ReuseSourceAction({
  dirty,
  busy,
  save,
  navigate,
}: {
  dirty: boolean;
  busy: boolean;
  save: () => Promise<boolean>;
  navigate: () => void;
}) {
  const t = useTranslations("Reuse");
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const saveFirst = async () => {
    if (saving || busy) return;
    setSaving(true);
    setFailed(false);
    try {
      if (await save()) navigate();
      else setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="mb-4">
      <Button
        variant="secondary"
        disabled={busy}
        onClick={() => {
          if (dirty) {
            setFailed(false);
            setOpen(true);
          } else navigate();
        }}
      >
        {t("action")}
      </Button>
      <Modal
        open={open}
        onClose={() => {
          if (!saving && !busy) setOpen(false);
        }}
        title={t("unsavedTitle")}
        footer={
          <div className="flex w-full flex-col gap-2 sm:flex-row sm:justify-end">
            <Button
              className="min-h-11"
              variant="secondary"
              disabled={saving || busy}
              onClick={() => setOpen(false)}
            >
              {t("cancel")}
            </Button>
            <Button
              className="min-h-11"
              variant="secondary"
              disabled={saving || busy}
              onClick={navigate}
            >
              {t("discard")}
            </Button>
            <Button className="min-h-11" disabled={saving || busy} onClick={() => void saveFirst()}>
              {saving ? t("saving") : t("save")}
            </Button>
          </div>
        }
      >
        <p className="text-sm text-fg-secondary">{t("unsavedBody")}</p>
        {failed && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {t("saveFailed")}
          </p>
        )}
      </Modal>
    </div>
  );
}
