"use client";

import type { ConversationMessages, MessageContent, MessageDto } from "@comanda/shared";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  ClockIcon,
  FileIcon,
  MapPinIcon,
  SparklesIcon,
  StickyNoteIcon,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { Avatar } from "@/components/inbox/bits";
import { OrderCard } from "@/components/inbox/order-card";
import { usePendingAction } from "@/hooks/use-pending-action";
import { ApiError } from "@/lib/api";
import { clock, weekdayClock } from "@/lib/format";
import { cn } from "@/lib/utils";

const AUTOMATION_LABEL: Record<NonNullable<MessageContent["automation"]>, string> = {
  phone_collection: "Automação · coleta de telefone",
  phone_reminder: "Automação · lembrete do telefone",
  phone_confirmation: "Automação · telefone confirmado",
  menu: "Automação · menu de atendimento",
  order_number_request: "Automação · número do pedido",
  order_lookup: "Automação · busca do pedido",
  order_confirmed: "Automação · pedido confirmado",
  order_links: "Automação · links para pedir",
  handoff: "Automação · encaminhado à equipe",
  survey: "Automação · pesquisa de satisfação",
  survey_thanks: "Automação · avaliação recebida",
  after_hours: "Automação · fora do horário",
  inactivity_close: "Automação · encerrada por inatividade",
};

const SUCCESS_EVENTS = new Set<MessageContent["event"]>(["phone_collected", "contacts_merged", "rating"]);
const WARNING_EVENTS = new Set<MessageContent["event"]>(["phone_pending", "opt_out", "merge_conflict", "order_ambiguous"]);

const MEDIA_LABEL: Partial<Record<MessageDto["type"], string>> = {
  IMAGE: "Imagem",
  AUDIO: "Áudio",
  VIDEO: "Vídeo",
  DOCUMENT: "Documento",
  STICKER: "Figurinha",
};

/** Linha do tempo da conversa: mensagens, eventos, notas e pedidos (board Inbox → "Mensagens"). */
export function MessageTimeline({
  data,
  contact,
}: {
  data: ConversationMessages;
  contact: { id: string; name: string | null };
}) {
  const end = useRef<HTMLDivElement>(null);
  const last = data.messages.at(-1)?.id;
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [last]);

  return (
    <div role="log" aria-label="Mensagens da conversa" className="flex flex-1 flex-col gap-2.5 overflow-y-auto px-5 pt-5 pb-3">
      {data.messages.map((message) => {
        const order = message.content.orderId ? data.orders[message.content.orderId] : undefined;
        if (message.type === "SYSTEM") {
          return order ? <OrderCard key={message.id} order={order} /> : <SystemEvent key={message.id} message={message} />;
        }
        if (message.type === "NOTE") return <Note key={message.id} message={message} />;
        if (message.content.automation) return <Automation key={message.id} message={message} />;
        return message.direction === "INBOUND" ? (
          <Inbound key={message.id} message={message} contact={contact} />
        ) : (
          <Outbound key={message.id} message={message} />
        );
      })}
      <div ref={end} />
    </div>
  );
}

function SystemEvent({ message }: { message: MessageDto }) {
  const { event, text } = message.content;
  const tone = SUCCESS_EVENTS.has(event)
    ? "border border-success-line bg-success-lt text-success-ink"
    : WARNING_EVENTS.has(event)
      ? "border border-warning-line bg-warning-lt text-warning-ink"
      : "bg-surface-2 text-ink-3";
  return (
    <div className="flex justify-center">
      <span className={cn("flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px]", tone)}>
        {SUCCESS_EVENTS.has(event) && <CheckCircle2Icon className="size-3" aria-hidden />}
        {text}
        {event === "conversation_opened" && ` · ${weekdayClock(message.createdAt)}`}
      </span>
    </div>
  );
}

function Automation({ message }: { message: MessageDto }) {
  return (
    <div className="mx-auto my-1 max-w-[76%] rounded-[10px] border border-warning-line bg-warning-lt px-3.5 py-2.5">
      <div className="mb-1 flex items-center gap-[5px] text-[10.5px] font-semibold text-warning-ink">
        <SparklesIcon className="size-3" aria-hidden />
        {AUTOMATION_LABEL[message.content.automation!]}
      </div>
      <div className="leading-[1.45] whitespace-pre-wrap">{message.content.text}</div>
      <div className="mt-1 text-right text-[10px] text-ink-3 tabular-nums">
        {clock(message.createdAt)} · enviado automaticamente
        <DeliveryStatus message={message} />
      </div>
    </div>
  );
}

function Note({ message }: { message: MessageDto }) {
  return (
    <div className="mx-auto my-1 max-w-[72%] rounded-xl border border-dashed border-warning-line bg-warning-lt px-3 py-2">
      <div className="mb-[3px] flex items-center gap-1 text-[10.5px] font-medium text-warning-ink">
        <StickyNoteIcon className="size-3" aria-hidden />
        Nota interna{message.sentBy && ` — ${message.sentBy.name.split(" ")[0]}`}
      </div>
      <div className="text-[12.5px] leading-[1.4] whitespace-pre-wrap text-ink-2">{message.content.text}</div>
      <div className="mt-[3px] text-right text-[10px] text-ink-3 tabular-nums">
        {clock(message.createdAt)} · visível só para a equipe
      </div>
    </div>
  );
}

function Inbound({ message, contact }: { message: MessageDto; contact: { id: string; name: string | null } }) {
  return (
    <div className="flex max-w-[72%] items-end gap-[7px]">
      <Avatar seed={contact.id} name={contact.name} className="size-[22px] text-[8px]" />
      <div className="rounded-[12px_12px_12px_2px] border border-rule bg-surface px-3 py-2">
        <MessageBody message={message} />
        <div className="mt-[3px] text-right text-[10px] text-ink-3 tabular-nums">{clock(message.createdAt)}</div>
      </div>
    </div>
  );
}

function Outbound({ message }: { message: MessageDto }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[68%] rounded-[12px_12px_2px_12px] bg-ink px-3 py-2 text-paper">
        <MessageBody message={message} />
        <div className="mt-[3px] text-right text-[10px] text-ink-3 tabular-nums">
          {clock(message.createdAt)}
          {message.sentBy && ` · ${message.sentBy.name.split(" ")[0]}`}
          <DeliveryStatus message={message} />
        </div>
      </div>
    </div>
  );
}

function MessageBody({ message }: { message: MessageDto }) {
  const { text, media, location } = message.content;
  const mediaLabel = MEDIA_LABEL[message.type];
  return (
    <>
      {mediaLabel && (
        <div className="mb-1 flex items-center gap-1.5 text-[12px] opacity-80">
          <FileIcon className="size-3.5" aria-hidden />
          {mediaLabel}
          {media?.filename && ` · ${media.filename}`}
        </div>
      )}
      {location && (
        <a
          href={`https://www.google.com/maps?q=${location.latitude},${location.longitude}`}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 underline-offset-2 hover:underline"
        >
          <MapPinIcon className="size-3.5" aria-hidden />
          {location.name ?? location.address ?? "Localização"}
        </a>
      )}
      {text && <div className="leading-[1.4] whitespace-pre-wrap">{text}</div>}
    </>
  );
}

/** Status de uma mensagem enviada: Enviando…, ✓, ✓✓ ou falha (com o motivo). */
function DeliveryStatus({ message }: { message: MessageDto }) {
  switch (message.status) {
    case "PENDING":
      return (
        <span className="ml-1 inline-flex items-center gap-0.5">
          · <ClockIcon className="size-2.5" aria-hidden /> enviando
        </span>
      );
    case "SENT":
      return <span className="ml-1">✓</span>;
    case "DELIVERED":
    case "READ":
      return <span className="ml-1">✓✓</span>;
    case "FAILED":
      return (
        <span className="ml-1 inline-flex items-center gap-0.5 text-[#F5B5AC]" title={message.statusError ?? undefined}>
          · <AlertCircleIcon className="size-2.5" aria-hidden /> não enviada · <RetryButton message={message} />
        </span>
      );
    default:
      return null;
  }
}

/** Reenvia uma mensagem que falhou; se não der (ex.: janela de 24h fechada), mostra o motivo no lugar do botão. */
function RetryButton({ message }: { message: MessageDto }) {
  const { request } = useAuth();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [retry, retrying] = usePendingAction(async () => {
    setError(null);
    try {
      await request(`/conversations/${message.conversationId}/messages/${message.id}/retry`, { method: "POST" });
      void queryClient.invalidateQueries({ queryKey: ["messages", message.conversationId] });
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "Não foi possível reenviar.");
    }
  });

  if (error) return <span>{error}</span>;
  return (
    <button
      type="button"
      onClick={() => retry()}
      disabled={retrying}
      className="underline underline-offset-2 hover:text-paper disabled:cursor-not-allowed disabled:no-underline"
    >
      {retrying ? "Carregando…" : "Tentar novamente"}
    </button>
  );
}
