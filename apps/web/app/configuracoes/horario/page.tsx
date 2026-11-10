"use client";

import { BusinessHoursTab } from "@/components/settings/business-hours-tab";
import { SettingsHeader } from "@/components/settings/settings-ui";

export default function BusinessHoursPage() {
  return (
    <>
      <SettingsHeader title="Horário" description="Quando o restaurante atende e o que o cliente recebe fora desse horário" />
      <BusinessHoursTab />
    </>
  );
}
