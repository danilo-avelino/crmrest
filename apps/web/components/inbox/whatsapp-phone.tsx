"use client";

import { type ChannelHealthDto, formatPhone } from "@dishdesk/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageCircleIcon } from "lucide-react";
import { useAuth } from "@/components/auth/auth-provider";
import { useToast } from "@/components/ui/toast";
import { usePendingAction } from "@/hooks/use-pending-action";
import { ApiError } from "@/lib/api";

/**
 * Abre (ou acha) a conversa com o cliente no WhatsApp do restaurante, pelo telefone do cadastro. `connected`: o
 * restaurante do cliente tem um WhatsApp conectado.
 */
export function useWhatsAppChat(contactId: string, tenantId: string, onOpen: (conversationId: string) => void) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  // Mesma consulta da faixa de canal desconectado (ChannelAlert).
  const channels = useQuery({ queryKey: ["channels"], queryFn: () => request<ChannelHealthDto[]>("/channels"), refetchInterval: 60_000 });
  const connected = Boolean(channels.data?.some((channel) => channel.tenantId === tenantId && channel.type === "WHATSAPP" && channel.status === "CONNECTED"));
  const open = async () => {
    try {
      const { conversationId } = await request<{ conversationId: string }>(`/contacts/${contactId}/whatsapp-chat`, { method: "POST" });
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
      onOpen(conversationId);
    } catch (failure) {
      toast(failure instanceof ApiError ? failure.message : "Não foi possível abrir a conversa no WhatsApp.");
    }
  };
  return { connected, open };
}

/** Telefone do cliente: com um WhatsApp conectado, o clique abre a conversa com ele; sem, é só o número. */
export function WhatsAppPhone({
  contactId,
  tenantId,
  phone,
  onOpen,
}: {
  contactId: string;
  tenantId: string;
  phone: string;
  onOpen: (conversationId: string) => void;
}) {
  const { connected, open } = useWhatsAppChat(contactId, tenantId, onOpen);
  const [click, opening] = usePendingAction(open);
  const number = formatPhone(phone);
  if (!connected) return <span className="tabular-nums">{number}</span>;
  return (
    <button
      type="button"
      onClick={() => click()}
      disabled={opening}
      title="Conversar pelo WhatsApp"
      aria-label={`Conversar pelo WhatsApp: ${number}`}
      className="inline-flex items-center gap-1 tabular-nums underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:text-ink-3"
    >
      {opening ? (
        "Carregando…"
      ) : (
        <>
          {number}
          <MessageCircleIcon className="size-3 shrink-0 text-ink-3" aria-hidden />
        </>
      )}
    </button>
  );
}
