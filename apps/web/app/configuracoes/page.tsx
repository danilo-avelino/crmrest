"use client";

import { SetupEntry } from "@/components/onboarding/setup-reminder";
import { PersonalityPage } from "@/components/settings/personality-tab";
import { useSettingsTenant } from "@/components/settings/settings-shell";
import { SettingsHeader } from "@/components/settings/settings-ui";

export default function PersonalitySettingsPage() {
  const tenant = useSettingsTenant();
  return (
    <>
      <SettingsHeader title="Personalidade" description="Como a IA e os avisos automáticos falam com o cliente" />
      <SetupEntry tenantId={tenant.id} />
      <PersonalityPage />
    </>
  );
}
