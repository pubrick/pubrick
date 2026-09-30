import { Suspense } from "react";
import { AuthRecoveryForm } from "@/components/AuthRecoveryForm";
export default function Page() {
  return (
    <Suspense>
      <AuthRecoveryForm mode="verify" />
    </Suspense>
  );
}
