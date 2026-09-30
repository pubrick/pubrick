import { useEffect, useState } from "react";
export type AuthCapabilities = {
  requiresEmailVerification: boolean;
  passwordRecoveryEnabled: boolean;
};
const defaults: AuthCapabilities = {
  requiresEmailVerification: false,
  passwordRecoveryEnabled: false,
};
export function useAuthCapabilities() {
  const [capabilities, setCapabilities] = useState(defaults);
  useEffect(() => {
    let active = true;
    fetch("/api/auth/pubrick-capabilities", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return;
        const data: unknown = await response.json();
        if (
          active &&
          data &&
          typeof data === "object" &&
          "requiresEmailVerification" in data &&
          typeof data.requiresEmailVerification === "boolean" &&
          "passwordRecoveryEnabled" in data &&
          typeof data.passwordRecoveryEnabled === "boolean"
        )
          setCapabilities({
            requiresEmailVerification: data.requiresEmailVerification,
            passwordRecoveryEnabled: data.passwordRecoveryEnabled,
          });
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  return capabilities;
}
