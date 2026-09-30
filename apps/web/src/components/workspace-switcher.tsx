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
        setWorkspaces(result.data.map(({ id, name }) => ({ id, name })));
      } catch {
        if (live) setError(t("workspaceLoadFailed"));
      }
    }
    void load();
    return () => {
      live = false;
    };
  }, [retry, t]);
  async function switchWorkspace() {
    if (
      busy ||
      !selected ||
      selected === activeId ||
      !workspaces?.some(({ id }) => id === selected)
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const result = await authClient.organization.setActive({ organizationId: selected });
      if (result.error) throw new Error("switch failed");
      // Full navigation discards all previous tenant component state and caches.
      navigateToWorkspace(locale);
    } catch {
      setError(t("workspaceSwitchFailed"));
      setBusy(false);
    }
  }
  return (
    <div className="mt-4 space-y-2">
      {workspaces === null && !error && <Skeleton lines={1} className="w-40 py-1" />}
      {workspaces !== null && workspaces.length > 0 && (
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1">
            <Select
              label={t("workspaceTitle")}
              value={selected}
              disabled={busy}
              onChange={(event) => {
                setSelected(event.target.value);
                setError(null);
              }}
            >
              {!selected && <option value="">{t("workspaceSelect")}</option>}
              {workspaces.map(({ id, name }) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </Select>
          </div>
          <Button
            variant="secondary"
            disabled={busy || !selected || selected === activeId}
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
