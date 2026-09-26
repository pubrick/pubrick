"use client";

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { ApiError, api, errorMessage } from "@/lib/api";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Modal } from "./ui/modal";

type FeedState =
  | { enabled: false; url: null; entries: [] }
  | {
      enabled: true;
      url: string;
      entries: {
        id: string;
        contentItemId: string;
        adaptationId: string | null;
        title: string;
        publishedAt: string;
      }[];
    };

/** Feed activation and revocation live with the brand's other settings. */
export function FeedSettings({ brandId }: { brandId: string }) {
  const t = useTranslations("Feed");
  const te = useTranslations("Errors");
  const [feed, setFeed] = useState<FeedState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const path = `/api/brands/${brandId}/feed`;

  useEffect(() => {
    api<FeedState>(path)
      .then(setFeed)
      .catch((err) => {
        if (err instanceof ApiError && err.noActiveOrg) return;
        setError(errorMessage(err, t("loadError"), te));
      });
  }, [path, t, te]);

  async function change(method: "POST" | "DELETE") {
    setBusy(true);
    setError(null);
    try {
      setFeed(await api<FeedState>(path, { method }));
      setConfirmDisable(false);
    } catch (err) {
      if (err instanceof ApiError && err.noActiveOrg) return;
      setError(errorMessage(err, t("saveError"), te));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mt-6">
      <h2 className="text-lg font-semibold text-fg">{t("title")}</h2>
      <p className="mt-2 text-sm text-fg-secondary">{t("description")}</p>
      <p className="mt-2 text-sm text-fg-secondary">{t("dzenNotice")}</p>
      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}
      {feed?.enabled ? (
        <div className="mt-4 flex flex-col gap-3">
          <a
            className="break-all text-sm text-accent hover:underline"
            href={feed.url}
            target="_blank"
            rel="noreferrer"
          >
            {feed.url}
          </a>
          <p className="text-sm text-fg-tertiary">
            {t("entryCount", { count: feed.entries.length })}
          </p>
          <div>
            <Button variant="danger" disabled={busy} onClick={() => setConfirmDisable(true)}>
              {t("disable")}
            </Button>
          </div>
        </div>
      ) : feed ? (
        <div className="mt-4">
          <Button variant="secondary" disabled={busy} onClick={() => change("POST")}>
            {t("enable")}
          </Button>
        </div>
      ) : null}
      <Modal
        open={confirmDisable}
        onClose={() => setConfirmDisable(false)}
        title={t("disableTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDisable(false)}>
              {t("cancel")}
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => change("DELETE")}>
              {t("disable")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-fg-secondary">{t("disableHint")}</p>
      </Modal>
    </Card>
  );
}

/** One post's explicit opt-in: no draft is ever made public by enabling an empty feed. */
export function FeedEntryAction({
  brandId,
  itemId,
  status,
  dzenAdaptationId,
}: {
  brandId: string;
  itemId: string;
  status: string;
  dzenAdaptationId?: string;
}) {
  const t = useTranslations("Feed");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const [feed, setFeed] = useState<FeedState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"add" | "remove" | null>(null);
  const path = `/api/brands/${brandId}/feed`;
  const eligible =
    status === "published" || status === "partially_published" || Boolean(dzenAdaptationId);

  useEffect(() => {
    if (!eligible) return;
    api<FeedState>(path)
      .then(setFeed)
      .catch((err) => {
        if (err instanceof ApiError && err.noActiveOrg) return;
        setError(errorMessage(err, t("loadError"), te));
      });
  }, [eligible, path, t, te]);

  if (!eligible) return null;
  const entry = feed?.entries.find((entry) => entry.contentItemId === itemId);
  const included = Boolean(entry);
  const dzenEntry = Boolean(entry?.adaptationId);
  const addingDzen = Boolean(dzenAdaptationId);

  async function change() {
    if (!confirm) return;
    setBusy(true);
    setError(null);
    try {
      setFeed(
        await api<FeedState>(
          confirm === "add" && dzenAdaptationId
            ? `${path}/adaptations/${dzenAdaptationId}`
            : `${path}/items/${itemId}`,
          {
            method: confirm === "add" ? "POST" : "DELETE",
          },
        ),
      );
      setConfirm(null);
    } catch (err) {
      if (err instanceof ApiError && err.noActiveOrg) return;
      setError(errorMessage(err, t("saveError"), te));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mt-6">
      <h2 className="text-lg font-semibold text-fg">{t("title")}</h2>
      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}
      {!feed ? null : !feed.enabled ? (
        <p className="mt-2 text-sm text-fg-secondary">
          {t("disabledHint")}{" "}
          <Link className="text-accent hover:underline" href={`/${locale}/brands/${brandId}`}>
            {t("brandSettings")}
          </Link>
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <p className="text-sm text-fg-secondary">
            {included ? t(dzenEntry ? "dzenAvailable" : "available") : t("notIncluded")}
          </p>
          <Button
            variant={included ? "danger" : "secondary"}
            disabled={busy}
            onClick={() => setConfirm(included ? "remove" : "add")}
          >
            {included ? t("remove") : t(addingDzen ? "addDzen" : "add")}
          </Button>
        </div>
      )}
      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={t(confirm === "add" ? (addingDzen ? "addDzenTitle" : "addTitle") : "removeTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirm(null)}>
              {t("cancel")}
            </Button>
            <Button
              variant={confirm === "add" ? "secondary" : "danger"}
              disabled={busy}
              onClick={change}
            >
              {t(confirm === "add" ? (addingDzen ? "addDzen" : "add") : "remove")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-fg-secondary">
          {t(confirm === "add" ? (addingDzen ? "addDzenHint" : "addHint") : "removeHint")}
        </p>
      </Modal>
    </Card>
  );
}
