"use client";

import { AgentPanel } from "@/components/agent/agent-panel";

/** A tela do painel lateral da extensão do Chrome (apps/extension/panel.html carrega esta página num iframe). */
export default function AgentPanelPage() {
  return (
    <div className="h-screen">
      <AgentPanel />
    </div>
  );
}
