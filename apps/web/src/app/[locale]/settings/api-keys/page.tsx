"use client";

import { type ApiKeyCreate, apiKeyCreateSchema, MAX_ACTIVE_API_KEYS } from "@pubrick/shared";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { ListRow } from "@/components/ui/list-row";
import { Modal } from "@/components/ui/modal";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, api, apiVoid, errorMessage } from "@/lib/api";

type KeyRow = {
  id: string;
  name: string;
  prefix: string;
  scope: ApiKeyCreate["scope"];
  createdAt: string;
  revokedAt: string | null;
};
type CreatedKey = KeyRow & { key: string };

const FORM_ID = "api-key-create-form";

export default function ApiKeysPage() {
  const t = useTranslations("ApiKeys");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const [keys, setKeys] = useState<KeyRow[] | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedKey | null>(null);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyDone, setCopyDone] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);

  // Modal's focus trap re-runs when onClose changes identity. Keep these
  // callbacks stable while an input in the dialog is being typed into.
  const closeCreate = useCallback(() => {
    setCreating(false);
    setCreated(null);
  }, []);
  const closeRevoke = useCallback(() => setRevokeId(null), []);

  const load = useCallback(async () => {
    try {
      setKeys(await api<KeyRow[]>("/api/api-keys"));
      setAccessDenied(false);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setAccessDenied(true);
        setError(null);
        return;
      }
      setError(errorMessage(err, t("genericError"), te));
    }
  }, [t, te]);
  useEffect(() => {
    void load();
  }, [load]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    const parsed = apiKeyCreateSchema.safeParse({ name, scope: "content:read" });
    if (!parsed.success) {
      setError(t("invalidName"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api<CreatedKey>("/api/api-keys", {
        method: "POST",
        body: JSON.stringify(parsed.data),
      });
      setCreated(result);
      setName("");
      await load();
    } catch (err) {
      setError(errorMessage(err, t("genericError"), te));
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    if (!revokeId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiVoid(`/api/api-keys/${revokeId}`, { method: "DELETE" });
      setRevokeId(null);
      await load();
    } catch (err) {
      setError(errorMessage(err, t("genericError"), te));
    } finally {
      setBusy(false);
    }
  }

  const activeCount = keys?.filter((key) => key.revokedAt === null).length ?? 0;
  return (
    <AppShell
      title={t("title")}
      primaryAction={
        accessDenied ? undefined : (
          <Button
            onClick={() => {
              setError(null);
              setCreated(null);
              setCopyDone(false);
              setCopyFailed(false);
              setCreating(true);
            }}
            disabled={keys === null || accessDenied || activeCount >= MAX_ACTIVE_API_KEYS}
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
          <p className="mb-3 text-sm text-fg-secondary">{t("hint")}</p>
          <p className="text-sm text-fg-tertiary">
            {t("limit", { count: activeCount, max: MAX_ACTIVE_API_KEYS })}
          </p>
          {error && (
            <p role="alert" className="mt-3 text-sm text-danger">
              {error}
            </p>
          )}
        </Card>
        {accessDenied ? (
          <Card>
            <p role="alert" className="text-sm text-fg-secondary">
              {t("ownerOnly")}
            </p>
          </Card>
        ) : keys === null ? (
          <Card>
            {error ? (
              <Button variant="secondary" onClick={() => void load()}>
                {t("retry")}
              </Button>
            ) : (
              <Skeleton lines={3} />
            )}
          </Card>
        ) : keys.length === 0 ? (
          <EmptyState
            title={t("emptyTitle")}
            action={<p className="text-sm text-fg-tertiary">{t("emptyHint")}</p>}
          />
        ) : (
          <Card padded={false}>
            {keys.map((key) => (
              <ListRow
                key={key.id}
                title={key.name}
                meta={`${key.scope} · ${key.prefix}… · ${key.revokedAt ? t("revoked") : t("active")}`}
                trailing={
                  key.revokedAt === null ? (
                    <Button variant="danger" size="sm" onClick={() => setRevokeId(key.id)}>
                      {t("revoke")}
                    </Button>
                  ) : undefined
                }
              />
            ))}
          </Card>
        )}
      </div>
      <Modal
        open={creating}
        onClose={closeCreate}
        title={created ? t("createdTitle") : t("createTitle")}
        footer={
          created ? (
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
        {created ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-fg-secondary">{t("oneTimeHint")}</p>
            <p className="text-sm font-medium text-fg">{t("secretLabel")}</p>
            <code className="break-all rounded-control border border-border bg-bg-sunken p-3 text-sm text-fg">
              {created.key}
            </code>
            <Button
              variant="secondary"
              onClick={() => {
                void (async () => {
                  try {
                    await navigator.clipboard.writeText(created.key);
                    setCopyDone(true);
                    setCopyFailed(false);
                  } catch {
                    setCopyFailed(true);
                  }
                })();
              }}
            >
              {copyDone ? t("copied") : t("copy")}
            </Button>
            {copyFailed && (
              <p role="alert" className="text-sm text-danger">
                {t("copyFailed")}
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
              onChange={(event) => setName(event.target.value)}
              required
              autoFocus
            />
            <p className="text-sm text-fg-secondary">
              {t("scope")}: {t("contentRead")}
            </p>
            <p className="text-sm text-fg-tertiary">{t("scopeHint")}</p>
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
