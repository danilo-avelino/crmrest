"use client";

import { LoaderCircleIcon, MessageSquareIcon, WifiOffIcon } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { ChannelAlert } from "@/components/inbox/channel-alert";
import { ConversationList } from "@/components/inbox/conversation-list";
import { ConversationPane } from "@/components/inbox/conversation-pane";
import { NavRail } from "@/components/inbox/nav-rail";
import { useInboxRealtime } from "@/hooks/use-inbox-realtime";

/** Inbox unificada (board "Inbox · Conversa ativa · Painel do cliente"). Desktop no MVP. */
export function InboxView() {
  // ?conversa=<id> abre direto uma conversa (botão "Abrir conversa" da tela de Clientes).
  const linked = useSearchParams().get("conversa");
  const [selectedId, setSelectedId] = useState<string | null>(linked);
  const offline = useInboxRealtime();

  return (
    <div className="flex h-screen overflow-hidden bg-paper">
      {offline && (
        <div
          role="status"
          className="fixed top-3 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-[7px] border border-[#FDE68A] bg-warning-lt px-3.5 py-2 text-xs font-medium text-warning-ink shadow-sm"
        >
          <WifiOffIcon className="size-3.5 text-[#D97706]" aria-hidden />
          Sem conexão com o servidor. As conversas podem estar desatualizadas.
          <span className="flex items-center gap-1 font-normal">
            <LoaderCircleIcon className="size-3 animate-spin" aria-hidden />
            Reconectando…
          </span>
        </div>
      )}
      <NavRail />
      <div className="flex min-w-0 flex-1 flex-col">
        <ChannelAlert />
        <div className="flex min-h-0 flex-1">
          <ConversationList selectedId={selectedId} onSelect={setSelectedId} />
          {selectedId ? (
            <ConversationPane key={selectedId} conversationId={selectedId} />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-ink-3">
              <MessageSquareIcon className="size-6" aria-hidden />
              <p>Selecione uma conversa para começar.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
