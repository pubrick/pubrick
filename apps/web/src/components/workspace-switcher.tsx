"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { authClient } from "@/lib/auth-client";
import { navigateToWorkspace } from "@/lib/workspace-navigation";

type Workspace = { id: string; name: string };
export function WorkspaceSwitcher({ activeId }: { activeId: string | null }) {
  const t = useTranslations("SettingsPage");
  const locale = useLocale();
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [selected, setSelected] = useState(activeId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    setSelected(activeId ?? "");
  }, [activeId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry intentionally invalidates the failed membership query.
  useEffect(() => {
    let live = true;
    setWorkspaces(null);
    setError(null);
    async function load() {
      try {
        const result = await authClient.organization.list();
        if (!live) return;
        if (result.error || !result.data) throw new Error("list failed");
        const memberships = result.data.map(({ id, name }) => ({ id, name }));
        setWorkspaces(memberships);
        setSelected((previous) => (memberships.some(({ id }) => id === previous) ? previous : ""));
      } catch {
        if (live) setError(t("workspaceLoadFailed"));
      }
    }
    void load();
    return () => {
      live = false;
    };
  }, [retry, t]);
  // A native select otherwise visually picks the first option while React's
  // value can still be an active organization whose membership was removed.
  const selectedId = workspaces?.some(({ id }) => id === selected) ? selected : "";
  async function switchWorkspace() {
    if (busy || !selectedId || selectedId === activeId) return;
    setBusy(true);
    setError(null);
    let result: Awaited<ReturnType<typeof authClient.organization.setActive>>;
    try {
      result = await authClient.organization.setActive({ organizationId: selectedId });
    } catch {
      // The server may already have committed the cookie/session change.
      // Read it through a new document rather than retaining old tenant state.
      navigateToWorkspace(locale);
      return;
    }
    const status = result?.error?.status;
    if (status && status >= 400 && status < 500 && status !== 408 && status !== 499) {
      setError(t("workspaceSwitchFailed"));
      setBusy(false);
      return;
    }
    // Success, 5xx, unknown responses and timeouts all need the authoritative
    // session. Full navigation discards previous tenant component/router state.
    navigateToWorkspace(locale);
  }
  return (
    <div className="mt-4 space-y-2">
      {workspaces === null && !error && <Skeleton lines={1} className="w-40 py-1" />}
      {workspaces !== null && workspaces.length > 0 && (
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1">
            <Select
              label={t("workspaceTitle")}
              value={selectedId}
              disabled={busy}
              onChange={(event) => {
                setSelected(event.target.value);
                setError(null);
              }}
            >
              {!selectedId && <option value="">{t("workspaceSelect")}</option>}
              {workspaces.map(({ id, name }) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </Select>
          </div>
          <Button
            variant="secondary"
            disabled={busy || !selectedId || selectedId === activeId}
            onClick={() => void switchWorkspace()}
          >
            {t(busy ? "workspaceSwitching" : "workspaceSwitch")}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {error && workspaces === null && (
        <Button variant="secondary" onClick={() => setRetry((value) => value + 1)}>
          {t("workspaceRetry")}
        </Button>
      )}
    </div>
  );
}
