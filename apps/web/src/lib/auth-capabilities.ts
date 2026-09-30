import { useEffect, useState } from "react";
export type AuthCapabilities = {
  requiresEmailVerification: boolean;
  passwordRecoveryEnabled: boolean;
  deploymentMode: "self-hosted" | "hosted" | null;
  billingEnabled: boolean;
  billingTestMode: boolean;
  ready: boolean;
};
const defaults: AuthCapabilities = {
  requiresEmailVerification: false,
  passwordRecoveryEnabled: false,
  deploymentMode: null,
  billingEnabled: false,
  billingTestMode: false,
  ready: false,
};
export function useAuthCapabilities() {
  const [capabilities, setCapabilities] = useState(defaults);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry advances the request generation.
  useEffect(() => {
    let active = true;
    setFailed(false);
    fetch("/api/auth/pubrick-capabilities", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Capabilities unavailable");
        const data: unknown = await response.json();
        if (
          active &&
          data &&
          typeof data === "object" &&
          "requiresEmailVerification" in data &&
          typeof data.requiresEmailVerification === "boolean" &&
          "passwordRecoveryEnabled" in data &&
          typeof data.passwordRecoveryEnabled === "boolean" &&
          "deploymentMode" in data &&
          (data.deploymentMode === "self-hosted" || data.deploymentMode === "hosted") &&
          "billingEnabled" in data &&
          typeof data.billingEnabled === "boolean" &&
          "billingTestMode" in data &&
          typeof data.billingTestMode === "boolean"
        )
          setCapabilities({
            requiresEmailVerification: data.requiresEmailVerification,
            passwordRecoveryEnabled: data.passwordRecoveryEnabled,
            deploymentMode: data.deploymentMode,
            billingEnabled: data.billingEnabled,
            billingTestMode: data.billingTestMode,
            ready: true,
          });
        else if (active) setFailed(true);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [attempt]);
  return { ...capabilities, failed, retry: () => setAttempt((value) => value + 1) };
}

export function workspaceMutationsAvailable(capabilities: AuthCapabilities): boolean {
  return (
    capabilities.ready &&
    (capabilities.deploymentMode === "self-hosted" ||
      (capabilities.deploymentMode === "hosted" && capabilities.billingEnabled))
  );
}
