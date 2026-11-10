"use client";

import { OrderLinksTab } from "@/components/settings/order-links-section";
import { SettingsHeader } from "@/components/settings/settings-ui";

export default function OrderLinksPage() {
  return (
    <>
      <SettingsHeader title="Links de pedido" description="Onde o cliente faz o pedido e vê o cardápio" />
      <OrderLinksTab />
    </>
  );
}
