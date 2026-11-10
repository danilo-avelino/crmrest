"use client";

import { NotificationsTab } from "@/components/settings/notifications-tab";
import { SettingsHeader } from "@/components/settings/settings-ui";

export default function NotificationsPage() {
  return (
    <>
      <SettingsHeader title="Notificações" description="Alertas e relatórios que o administrador recebe pelo WhatsApp" />
      <NotificationsTab />
    </>
  );
}
