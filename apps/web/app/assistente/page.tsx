"use client";

import { Suspense } from "react";
import { RequireAdminContext } from "@/components/auth/require-context";
import { SetupWizard } from "@/components/onboarding/setup-wizard";

export default function SetupWizardPage() {
  return (
    <RequireAdminContext>
      <Suspense>
        <SetupWizard />
      </Suspense>
    </RequireAdminContext>
  );
}
