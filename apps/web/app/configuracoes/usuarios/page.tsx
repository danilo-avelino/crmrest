"use client";

import { MembersTab } from "@/components/settings/members-tab";
import { SettingsHeader } from "@/components/settings/settings-ui";

export default function MembersPage() {
  return (
    <>
      <SettingsHeader title="Usuários" description="Quem atende e quem administra o restaurante" />
      <MembersTab />
    </>
  );
}
