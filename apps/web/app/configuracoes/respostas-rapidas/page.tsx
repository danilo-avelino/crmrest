"use client";

import { QuickRepliesTab } from "@/components/settings/quick-replies-tab";
import { SettingsHeader } from "@/components/settings/settings-ui";

export default function QuickRepliesPage() {
  return (
    <>
      <SettingsHeader title="Respostas rápidas" description="Textos prontos que a equipe insere na conversa com um atalho" />
      <QuickRepliesTab />
    </>
  );
}
