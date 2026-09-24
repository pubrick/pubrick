"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { use, useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, api, errorMessage } from "@/lib/api";

type Member = {
  memberId: string;
  userId: string;
  name: string;
  email: string;
  role: string;
  hasAccess: boolean;
};
type Access = { members: Member[] };

function isManager(member: Member): boolean {
  return member.role === "owner" || member.role === "admin";
}

export default function BrandAccessPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations("BrandAccess");
  const te = useTranslations("Errors");
  const locale = useLocale();
  const router = useRouter();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "denied" | "missing" | "error">(
    "loading",
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setStatus("loading");
    setError(null);
    try {
      const result = await api<Access>(`/api/brands/${id}/access`);
      setMembers(result.members);
      setSelected(
        result.members
          .filter((member) => !isManager(member) && member.hasAccess)
          .map((member) => member.memberId),
      );
      setStatus("ready");
    } catch (err) {
      if (err instanceof ApiError && err.noActiveOrg) {
        router.replace(`/${locale}/onboarding`);
        return;
      }
      if (err instanceof ApiError && err.status === 403) {
        setStatus("denied");
        return;
      }
      if (err instanceof ApiError && err.status === 404) {
        setStatus("missing");
        return;
      }
      setError(errorMessage(err, t("genericError"), te));
      setStatus("error");
    }
  }, [id, locale, router, t, te]);

  useEffect(() => {
    void load();
  }, [load]);

  const original =
    members
      ?.filter((member) => !isManager(member) && member.hasAccess)
      .map((member) => member.memberId) ?? [];
  const dirty =
    selected.length !== original.length ||
    selected.some((memberId) => !original.includes(memberId));
  const ordinaryMembers = members?.filter((member) => !isManager(member)) ?? [];

  function toggle(memberId: string) {
    if (saving) return;
    setSaved(false);
    setError(null);
    setSelected((previous) =>
      previous.includes(memberId)
        ? previous.filter((id) => id !== memberId)
        : [...previous, memberId],
    );
  }

  async function save() {
    if (saving || !dirty || status !== "ready") return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const result = await api<Access>(`/api/brands/${id}/access`, {
        method: "PUT",
        body: JSON.stringify({ memberIds: selected }),
      });
      // The response reflects the committed grants and current membership.
      setMembers(result.members);
      setSelected(
        result.members
          .filter((member) => !isManager(member) && member.hasAccess)
          .map((member) => member.memberId),
      );
      setSaved(true);
    } catch (err) {
      if (err instanceof ApiError && err.noActiveOrg) {
        router.replace(`/${locale}/onboarding`);
      } else if (err instanceof ApiError && err.status === 403) {
        setStatus("denied");
      } else if (err instanceof ApiError && err.status === 404) {
        setStatus("missing");
      } else {
        setError(errorMessage(err, t("genericError"), te));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <AppShell
      title={t("title")}
      primaryAction={
        status === "ready" ? (
          <Button onClick={() => void save()} disabled={!dirty || saving}>
            {saving ? t("saving") : t("save")}
          </Button>
        ) : undefined
      }
    >
      <div className="flex max-w-2xl flex-col gap-4">
        <Link href={`/${locale}/brands/${id}`} className="text-sm text-accent underline">
          {t("back")}
        </Link>
        <Card>
          <h2 className="text-base font-semibold text-fg">{t("heading")}</h2>
          <p className="mt-2 text-sm text-fg-secondary">{t("hint")}</p>
          <p className="mt-2 text-sm text-fg-tertiary">{t("managerHint")}</p>
        </Card>
        {status === "loading" && (
          <Card aria-busy="true">
            <Skeleton lines={4} />
          </Card>
        )}
        {status === "denied" && (
          <Card>
            <p role="alert" className="text-sm text-fg-secondary">
              {t("ownerOnly")}
            </p>
          </Card>
        )}
        {status === "missing" && (
          <Card>
            <p role="alert" className="text-sm text-fg-secondary">
              {t("missing")}
            </p>
          </Card>
        )}
        {status === "error" && (
          <Card>
            <p role="alert" className="mb-3 text-sm text-danger">
              {error}
            </p>
            <Button variant="secondary" onClick={() => void load()}>
              {t("retry")}
            </Button>
          </Card>
        )}
        {status === "ready" && members && (
          <Card padded={false}>
            {members.length === 0 ? (
              <div className="p-4 text-sm text-fg-secondary">{t("empty")}</div>
            ) : (
              <ul aria-label={t("membersLabel")} className="divide-y divide-border">
                {members.map((member) => {
                  const manager = isManager(member);
                  return (
                    <li key={member.memberId}>
                      <label className="flex min-h-11 cursor-pointer items-center gap-3 px-4 py-3 has-[:disabled]:cursor-default">
                        <input
                          type="checkbox"
                          checked={manager || selected.includes(member.memberId)}
                          disabled={manager || saving}
                          onChange={() => toggle(member.memberId)}
                          className="size-4 shrink-0 accent-accent"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-fg">
                            {member.name || member.email}
                          </span>
                          <span className="block truncate text-sm text-fg-secondary">
                            {member.email}
                          </span>
                        </span>
                        {manager && (
                          <span className="text-xs text-fg-tertiary">{t("alwaysAccess")}</span>
                        )}
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        )}
        {status === "ready" && ordinaryMembers.length === 0 && (
          <p className="text-sm text-fg-secondary">
            {t("inviteHint")}{" "}
            <Link href={`/${locale}/settings`} className="font-medium text-accent underline">
              {t("openSettings")}
            </Link>
          </p>
        )}
        {status === "ready" && dirty && (
          <Button
            variant="secondary"
            className="self-start"
            disabled={saving}
            onClick={() => {
              setSelected(original);
              setError(null);
            }}
          >
            {t("discard")}
          </Button>
        )}
        {status === "ready" && error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        {status === "ready" && saved && (
          <p role="status" className="text-sm text-fg-secondary">
            {t("saved")}
          </p>
        )}
      </div>
    </AppShell>
  );
}
