"use client";

import { CHANNEL_CAPABILITIES, CHANNEL_LABEL, type ConversationListItem, type ConversationPage, COURIER_TAG, type MessageDto } from "@dishdesk/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircleIcon, CheckIcon, ForwardIcon, ImageIcon, LoaderCircleIcon, MapPinIcon, MessageSquareIcon, SearchIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { Avatar } from "@/components/inbox/bits";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { useIfoodWidget } from "@/components/ifood-widget";
import { useNow } from "@/hooks/use-now";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Mensagem que pode ser encaminhada: texto, localização ou arquivo do cliente ou da equipe (automação e nota, não). */
export function canForward(message: MessageDto): boolean {
  const { text, location, media, automation, aiReview } = message.content;
  if (message.direction === "INTERNAL" || automation || aiReview === "blocked") return false;
  if (!["TEXT", "IMAGE", "AUDIO", "VIDEO", "DOCUMENT", "LOCATION"].includes(message.type)) return false;
  return Boolean(text || location || media);
}

/** O que a mensagem leva, para a prévia do diálogo. */
function preview(message: MessageDto) {
  const { text, location, media } = message.content;
  if (location) return { icon: MapPinIcon, text: [location.name, location.address].filter(Boolean).join(" · ") || "Localização" };
  if (media) return { icon: ImageIcon, text: text ? `Arquivo: ${text}` : "Arquivo" };
  return { icon: MessageSquareIcon, text: text ?? "" };
}

/**
 * Encaminhar uma mensagem para outra conversa do mesmo restaurante (ex.: a localização que o cliente mandou vai para o
 * entregador). Só aparecem como destino as conversas que recebem a mensagem pelo Dish Desk; o arquivo só vai para o WhatsApp.
 */
export function ForwardDialog({
  message,
  tenantId,
  onClose,
}: {
  message: MessageDto | null;
  tenantId: string;
  onClose: () => void;
}) {
  return (
    <Dialog open={message !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[calc(100vh-5rem)] w-[440px] flex-col">
        {message && <ForwardForm message={message} tenantId={tenantId} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function ForwardForm({ message, tenantId, onClose }: { message: MessageDto; tenantId: string; onClose: () => void }) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const ifoodChat = useIfoodWidget().data?.chat === true;
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  const [target, setTarget] = useState<ConversationListItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setTerm(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // Sem busca: as conversas abertas (com a equipe e as automáticas); com busca, qualquer uma que não esteja resolvida.
  const candidates = useQuery({
    queryKey: ["forward-targets", tenantId, term],
    queryFn: async () => {
      const page = (status: string | null) =>
        request<ConversationPage>(`/conversations?${new URLSearchParams({ tenantId, ...(status && { status }), ...(term && { search: term }) })}`);
      const pages = term ? [await page(null)] : await Promise.all([page("ACTIVE"), page("AUTO")]);
      return pages.flatMap((result) => result.items).filter((item) => item.status !== "RESOLVED" && item.id !== message.conversationId);
    },
  });

  const now = useNow(60_000);
  const blockedReason = (item: ConversationListItem): string | null => {
    const capabilities = CHANNEL_CAPABILITIES[item.channel.type];
    if (item.teamOnly) return "O cliente não está nesta conversa";
    if (!(capabilities.send || (item.channel.type === "IFOOD" && ifoodChat))) return `O ${CHANNEL_LABEL[item.channel.type]} não recebe mensagens pelo Dish Desk`;
    if (message.content.media && item.channel.type !== "WHATSAPP") return `O ${CHANNEL_LABEL[item.channel.type]} não recebe arquivos encaminhados`;
    if (message.content.media && item.channel.type === "WHATSAPP" && capabilities.window24h) return "Arquivos só vão para o WhatsApp conectado por QR Code";
    if (capabilities.window24h && (!item.windowExpiresAt || new Date(item.windowExpiresAt).getTime() < now)) return "A janela de 24h desta conversa terminou";
    return null;
  };
  const items = [...(candidates.data ?? [])].sort((a, b) => Number(blockedReason(a) !== null) - Number(blockedReason(b) !== null));

  const send = async () => {
    if (!target) return;
    setError(null);
    try {
      await request(`/conversations/${message.conversationId}/messages/${message.id}/forward`, { method: "POST", body: { conversationId: target.id } });
      for (const queryKey of [["messages", target.id], ["conversation", target.id], ["conversations"]]) void queryClient.invalidateQueries({ queryKey });
      toast(`Encaminhada para ${target.contact.name ?? "o cliente"}`);
      onClose();
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "Não foi possível encaminhar. Tente novamente.");
    }
  };

  const shown = preview(message);
  return (
    <>
      <div className="shrink-0 border-b border-rule px-5 pt-[18px] pb-3.5">
        <DialogTitle className="mb-0.5">Encaminhar mensagem</DialogTitle>
        <DialogDescription>A conversa escolhida recebe a mensagem, com a marca “Encaminhada”.</DialogDescription>
      </div>
      <div className="mx-5 mt-3.5 flex items-start gap-2 rounded-lg bg-paper px-3 py-2.5 text-[12.5px] text-ink-2">
        <shown.icon className="mt-0.5 size-3.5 shrink-0 text-ink-3" aria-hidden />
        <span className="line-clamp-3 whitespace-pre-wrap">{shown.text}</span>
      </div>
      <div className="px-5 pt-3 pb-1.5">
        <label className="flex h-8 items-center gap-2 rounded-md border border-rule bg-paper px-2.5 focus-within:border-ink">
          <SearchIcon className="size-3.5 shrink-0 text-ink-3" aria-hidden />
          <input
            autoFocus
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar conversa"
            aria-label="Buscar conversa para encaminhar"
            className="w-full bg-transparent text-[12px] outline-none placeholder:text-ink-3"
          />
        </label>
      </div>
      <div className="min-h-[120px] flex-1 overflow-y-auto px-3 pb-2" role="listbox" aria-label="Conversas">
        {candidates.isPending ? (
          <div className="flex justify-center py-6 text-ink-3">
            <LoaderCircleIcon className="size-4 animate-spin" aria-label="Carregando…" />
          </div>
        ) : candidates.isError ? (
          <p className="py-6 text-center text-[12px] text-ink-3">Não foi possível carregar as conversas.</p>
        ) : items.length === 0 ? (
          <p className="py-6 text-center text-[12px] text-ink-3">Nenhuma conversa encontrada.</p>
        ) : (
          items.map((item) => {
            const reason = blockedReason(item);
            const chosen = target?.id === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={chosen}
                disabled={reason !== null}
                onClick={() => setTarget(item)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left disabled:cursor-not-allowed disabled:opacity-55",
                  chosen ? "bg-tomate-lt ring-1 ring-tomate-line" : "hover:bg-surface-2 disabled:hover:bg-transparent",
                )}
              >
                <Avatar seed={item.contact.id} name={item.contact.name} channel={item.channel.type} className="size-[30px] text-[11px]" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium">
                    {item.contact.name ?? "Cliente sem nome"}
                    {item.contact.tags.includes(COURIER_TAG) && <span className="font-normal text-ink-3"> · entregador</span>}
                  </span>
                  <span className="block truncate text-[11px] text-ink-3">{reason ?? CHANNEL_LABEL[item.channel.type]}</span>
                </span>
                {chosen && <CheckIcon className="size-4 shrink-0 text-tomate" aria-hidden />}
              </button>
            );
          })
        )}
      </div>
      {error && (
        <p role="alert" className="mx-5 mb-2 flex items-center gap-1.5 text-[11.5px] text-tomate">
          <AlertCircleIcon className="size-3 shrink-0" aria-hidden />
          {error}
        </p>
      )}
      <div className="flex shrink-0 justify-end gap-2 border-t border-rule px-5 py-3">
        <Button variant="outline" size="sm" onClick={onClose}>
          Cancelar
        </Button>
        <Button variant="accent" size="sm" disabled={!target} onClick={send}>
          <ForwardIcon aria-hidden />
          Encaminhar
        </Button>
      </div>
    </>
  );
}
