"use client";

import { Suspense } from "react";
import { BillingTab } from "@/components/settings/billing-tab";
import { SettingsHeader } from "@/components/settings/settings-ui";

export default function BillingPage() {
  return (
    <>
      <SettingsHeader title="Pagamento" description="A situação da assinatura e os planos do Dish Desk" />
      <Suspense>
        <BillingTab />
      </Suspense>
    </>
  );
}
