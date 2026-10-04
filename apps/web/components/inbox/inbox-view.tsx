"use client";

import { MessageSquareIcon } from "lucide-react";
import { useState } from "react";
import { ConversationList } from "@/components/inbox/conversation-list";
import { ConversationPane } from "@/components/inbox/conversation-pane";
import { NavRail } from "@/components/inbox/nav-rail";
import { useInboxRealtime } from "@/hooks/use-inbox-realtime";

/** Inbox unificada (board "Inbox · Conversa ativa · Painel do cliente"). Desktop no MVP. */
export function InboxView() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useInboxRealtime();

  return (
    <div className="flex h-screen overflow-hidden bg-paper">
      <NavRail />
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
  );
}
