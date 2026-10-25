"use client";

import { SetupEntry } from "@/components/onboarding/setup-reminder";
import { OrderLinksTab } from "@/components/settings/order-links-section";
import { useSettingsTenant } from "@/components/settings/settings-shell";

export default function OrderLinksPage() {
  const tenant = useSettingsTenant();
  return (
    <>
      <SetupEntry tenantId={tenant.id} />
      <OrderLinksTab />
    </>
  );
}
