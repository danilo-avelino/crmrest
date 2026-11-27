"use client";

import { MenuSettingsPage } from "@/components/menu/menu-shell";
import { TagBenefitsTab } from "@/components/settings/tag-benefits-tab";
import { SettingsHeader } from "@/components/settings/settings-ui";

export default function Page() {
  return (
    <MenuSettingsPage>
      <SettingsHeader title="Vantagens por tag" description="Cupons para os clientes VIP, fiéis, novos e sumidos, e o presente para recuperar quem saiu chateado" />
      <TagBenefitsTab />
    </MenuSettingsPage>
  );
}
