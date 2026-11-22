"use client";

import { MetaAdsTab } from "@/components/settings/meta-ads-tab";
import { SettingsHeader } from "@/components/settings/settings-ui";

export default function MetaAdsPage() {
  return (
    <>
      <SettingsHeader title="Meta Ads" description="Pixel e Conversions API da Meta no cardápio digital, com o consentimento do visitante" />
      <MetaAdsTab />
    </>
  );
}
