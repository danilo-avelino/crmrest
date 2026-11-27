"use client";

import { MenuSettingsPage } from "@/components/menu/menu-shell";
import { MenuAgentTab } from "@/components/settings/menu-agent-tab";

/** Formulário e simulação lado a lado: largura do board. */
export default function Page() {
  return (
    <MenuSettingsPage wide>
      <MenuAgentTab />
    </MenuSettingsPage>
  );
}
