"use client";

import { MenuStoreTab } from "@/components/settings/menu-store-tab";
import { SettingsHeader } from "@/components/settings/settings-ui";

export default function MenuStorePage() {
  return (
    <>
      <SettingsHeader title="Cardápio e entrega" description="Endereço, entrega, mínimo, agendamento, marca e contato da página pública do cardápio" />
      <MenuStoreTab />
    </>
  );
}
