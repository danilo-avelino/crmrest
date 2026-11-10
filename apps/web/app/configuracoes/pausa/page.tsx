"use client";

import { PauseTab } from "@/components/settings/pause-tab";
import { SettingsHeader } from "@/components/settings/settings-ui";

export default function PausePage() {
  return (
    <>
      <SettingsHeader title="Pausa" description="Desligue a IA e as automações sem desconectar os canais" />
      <PauseTab />
    </>
  );
}
