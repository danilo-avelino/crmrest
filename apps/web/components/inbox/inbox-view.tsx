"use client";

import { LoaderCircleIcon, WifiOffIcon } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useRef, useState } from "react";
import { ChannelAlert } from "@/components/inbox/channel-alert";
import { ConversationList } from "@/components/inbox/conversation-list";
import { ConversationPane } from "@/components/inbox/conversation-pane";
import { IfoodExtensionAlert } from "@/components/inbox/ifood-extension-alert";
import { InboxHome } from "@/components/inbox/inbox-home";
import { NavRail } from "@/components/inbox/nav-rail";
import { useInboxRealtime } from "@/hooks/use-inbox-realtime";

/** Inbox unificada (board "Inbox · Conversa ativa · Painel do cliente"). Desktop no MVP. */
export function InboxView() {
  // ?conversa=<id> abre direto uma conversa (botão "Abrir conversa" da tela de Clientes).
  const linked = useSearchParams().get("conversa");
  const [selectedId, setSelectedId] = useState<string | null>(linked);
  // Link para outra conversa aberto de dentro da Inbox (no cadastro do cliente): a seleção acompanha o endereço.
  const [followed, setFollowed] = useState(linked);
  if (linked !== followed) {
    setFollowed(linked);
    if (linked) setSelectedId(linked);
  }
  const offline = useInboxRealtime();
  // Conversas na ordem em que a lista as mostra: "Resolver" passa para a seguinte (ou a anterior, se era a última).
  const listedRef = useRef<string[]>([]);
  const nextAfter = (id: string) => {
    const index = listedRef.current.indexOf(id);
    return (index === -1 ? listedRef.current[0] : (listedRef.current[index + 1] ?? listedRef.current[index - 1])) ?? null;
  };

  return (
    <div className="flex h-full overflow-hidden bg-paper">
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
        <IfoodExtensionAlert />
        <div className="flex min-h-0 flex-1">
          <ConversationList selectedId={selectedId} onSelect={setSelectedId} listedRef={listedRef} />
          {selectedId ? (
            <ConversationPane
              key={selectedId}
              conversationId={selectedId}
              onOpenConversation={setSelectedId}
              nextConversationId={() => nextAfter(selectedId)}
            />
          ) : (
            <InboxHome />
          )}
        </div>
      </div>
    </div>
  );
}
