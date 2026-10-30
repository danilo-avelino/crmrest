"use client";

import type { ConversationCounts } from "@dishdesk/shared";
import { useQuery } from "@tanstack/react-query";
import { BellIcon, BellRingIcon, MessageSquareIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { beep } from "@/components/inbox/conversation-list";
import { useAgentAlarm } from "@/hooks/use-agent-alarm";
import { useInboxRealtime } from "@/hooks/use-inbox-realtime";

const NOTICE_CLASS = "flex items-center gap-2 rounded-[7px] px-3.5 py-2 text-xs font-medium shadow-sm";

/**
 * A Inbox continua avisando fora dela (Configurações, Avaliações, Clientes...): mantém o realtime, toca o alarme
 * de chamado e o bipe de nova mensagem e mostra um aviso no topo com o atalho para a Inbox.
 */
export function InboxWatcher() {
  const { request } = useAuth();
  useInboxRealtime();
  const counts = useQuery({
    queryKey: ["counts", null],
    queryFn: () => request<ConversationCounts>("/conversations/counts"),
  });
  const quiet = counts.data?.awaitingQuiet ?? 0;
  const calling = (counts.data?.awaitingAgent ?? 0) - quiet;
  const alarm = useAgentAlarm(calling > 0, "urgent", counts.data?.urgentSince ?? null);
  const quietAlarm = useAgentAlarm(quiet > 0, "quiet");
  const unread = counts.data?.unread ?? 0;

  // Não lidas de quando a página abriu (ou o aviso foi fechado): o aviso só aparece para o que chegou depois.
  const [baseline, setBaseline] = useState<number | null>(null);
  if (counts.data && (baseline === null || unread < baseline)) setBaseline(unread);
  const fresh = baseline !== null && unread > baseline;

  const previous = useRef<number | null>(null);
  useEffect(() => {
    if (!counts.data) return;
    const title = unread > 0 ? `(${unread}) Dish Desk` : "Dish Desk";
    document.title = calling > 0 ? `🔔 Chamando atendente · ${title}` : title;
    if (previous.current !== null && unread > previous.current && calling + quiet === 0) beep();
    previous.current = unread;
  }, [counts.data, unread, calling, quiet]);

  if (calling <= 0 && quiet <= 0 && !fresh) return null;
  return (
    <div className="fixed top-3 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
      {calling > 0 && (
        <Link href="/inbox" role="alert" className={`${NOTICE_CLASS} bg-tomate text-white`}>
          <BellRingIcon className="size-3.5 animate-bounce" aria-hidden />
          {calling === 1 ? "1 conversa chamando um atendente" : `${calling} conversas chamando um atendente`}
          <span className="font-normal underline">Abrir Inbox</span>
          {alarm.blocked && <span className="font-normal opacity-90">· clique para ativar o som</span>}
        </Link>
      )}
      {quiet > 0 && (
        <Link href="/inbox" role="status" className={`${NOTICE_CLASS} bg-ink text-paper`}>
          <BellIcon className="size-3.5" aria-hidden />
          {quiet === 1 ? "1 conversa aguardando um atendente" : `${quiet} conversas aguardando um atendente`}
          <span className="font-normal underline">Abrir Inbox</span>
          {quietAlarm.blocked && <span className="font-normal opacity-90">· clique para ativar o som</span>}
        </Link>
      )}
      {fresh && calling + quiet === 0 && (
        <div role="status" className={`${NOTICE_CLASS} bg-ink text-paper`}>
          <MessageSquareIcon className="size-3.5" aria-hidden />
          Nova mensagem na Inbox
          <Link href="/inbox" className="font-normal underline">
            Abrir Inbox
          </Link>
          <button type="button" aria-label="Fechar aviso" onClick={() => setBaseline(unread)} className="ml-1 opacity-70 hover:opacity-100">
            <XIcon className="size-3.5" aria-hidden />
          </button>
        </div>
      )}
    </div>
  );
}
