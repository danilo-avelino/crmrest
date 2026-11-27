"use client";

import { MenuSettingsPage } from "@/components/menu/menu-shell";
import { MenuPaymentsTab } from "@/components/settings/menu-payments-tab";
import { SettingsHeader } from "@/components/settings/settings-ui";

export default function Page() {
  return (
    <MenuSettingsPage>
      <SettingsHeader title="Pagamentos do cardápio" description="Como o cliente paga o pedido feito pelo cardápio digital" />
      <MenuPaymentsTab />
    </MenuSettingsPage>
  );
}
