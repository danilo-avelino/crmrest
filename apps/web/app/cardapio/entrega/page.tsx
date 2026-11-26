"use client";

import { MenuSettingsPage } from "@/components/menu/menu-shell";
import { MenuStoreTab } from "@/components/settings/menu-store-tab";
import { SettingsHeader } from "@/components/settings/settings-ui";

export default function Page() {
  return (
    <MenuSettingsPage>
      <SettingsHeader title="Cardápio e entrega" description="Endereço, entrega, mínimo, agendamento, marca e contato da página pública do cardápio" />
      <MenuStoreTab />
    </MenuSettingsPage>
  );
}
