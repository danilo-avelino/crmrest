"use client";

import { BusinessHoursTab } from "@/components/settings/business-hours-tab";
import { SettingsHeader } from "@/components/settings/settings-ui";
import { StoreClosuresSection } from "@/components/settings/store-closures-card";

export default function BusinessHoursPage() {
  return (
    <>
      <SettingsHeader title="Horário" description="Quando o restaurante atende e o que o cliente recebe fora desse horário" />
      <div className="flex flex-col gap-5">
        <BusinessHoursTab />
        <StoreClosuresSection />
      </div>
    </>
  );
}
