"use client";

import type { ConversationEvaluationDto, ConversationMessages, MessageContent, MessageDto } from "@dishdesk/shared";
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  ClockIcon,
  MapPinIcon,
  SparklesIcon,
  StarIcon,
  StickyNoteIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { Avatar } from "@/components/inbox/bits";
import { MessageMedia } from "@/components/inbox/message-media";
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
  order_forecast: "Automação · previsão de saída",
  order_ready: "Automação · pedido pronto",
  order_dispatched: "Automação · pedido saiu para entrega",
  order_delivered: "Automação · pedido entregue",
  order_links: "Automação · links para pedir",
  handoff: "Automação · encaminhado à equipe",
  survey: "Automação · pesquisa de satisfação",
  survey_thanks: "Automação · avaliação recebida",
  after_hours: "Automação · fora do horário",
  inactivity_close: "Automação · encerrada por inatividade",
  courier_menu: "Automação · menu do entregador",
  courier_arrival: "Automação · entregador chegou",
  courier_arrival_confirmed: "Automação · cliente avisado da chegada",
  courier_problem_request: "Automação · problema com o pedido",
};

const SUCCESS_EVENTS = new Set<MessageContent["event"]>(["phone_collected", "contacts_merged", "rating"]);
const WARNING_EVENTS = new Set<MessageContent["event"]>(["phone_pending", "opt_out", "merge_conflict", "order_ambiguous"]);

/** Linha do tempo da conversa: mensagens, eventos, notas e pedidos (board Inbox → "Mensagens"). */
export function MessageTimeline({
  data,
  contact,
  onOpenConversation,
}: {
  data: ConversationMessages;
  contact: { id: string; name: string | null };
  /** Abre outra conversa na Inbox (botão de conversar com o cliente, no card do pedido). */
  onOpenConversation: (id: string) => void;
}) {
  const end = useRef<HTMLDivElement>(null);
  const last = data.messages.at(-1)?.id;
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [last]);

  // Cada avaliação da IA entra depois da última mensagem anterior a ela.
  const evaluationsAfter = new Map<string, ConversationEvaluationDto[]>();
  const leading: ConversationEvaluationDto[] = [];
  for (const evaluation of data.evaluations) {
    const before = data.messages.findLast((message) => message.createdAt <= evaluation.createdAt);
    if (!before) leading.push(evaluation);
    else evaluationsAfter.set(before.id, [...(evaluationsAfter.get(before.id) ?? []), evaluation]);
  }

  return (
    <div role="log" aria-label="Mensagens da conversa" className="flex flex-1 flex-col gap-2.5 overflow-y-auto px-5 pt-5 pb-3">
      {leading.map((evaluation) => (
        <Evaluation key={evaluation.id} evaluation={evaluation} />
      ))}
      {data.messages.map((message) => (
        <Fragment key={message.id}>
          <TimelineMessage message={message} data={data} contact={contact} onOpenConversation={onOpenConversation} />
          {evaluationsAfter.get(message.id)?.map((evaluation) => <Evaluation key={evaluation.id} evaluation={evaluation} />)}
        </Fragment>
      ))}
      <div ref={end} />
    </div>
  );
}

function TimelineMessage({
  message,
  data,
  contact,
  onOpenConversation,
}: {
  message: MessageDto;
  data: ConversationMessages;
  contact: { id: string; name: string | null };
  onOpenConversation: (id: string) => void;
}) {
  const order = message.content.orderId ? data.orders[message.content.orderId] : undefined;
  if (message.type === "SYSTEM") {
    return order ? (
      <OrderCard
        order={order}
        conversationId={message.conversationId}
        onOpenCustomerChat={message.content.customerChat ? onOpenConversation : undefined}
      />
    ) : (
      <SystemEvent message={message} />
    );
  }
  if (message.type === "NOTE") return <Note message={message} />;
  if (message.content.automation) return <Automation message={message} />;
  return message.direction === "INBOUND" ? <Inbound message={message} contact={contact} /> : <Outbound message={message} />;
}

function SystemEvent({ message }: { message: MessageDto }) {
  const { event, text } = message.content;
  const tone = SUCCESS_EVENTS.has(event)
    ? "border border-success-line bg-success-lt text-success-ink"
    : event === "cancellation_alert"
      ? "border border-tomate-line bg-tomate-lt font-semibold text-tomate"
      : WARNING_EVENTS.has(event)
      ? "border border-warning-line bg-warning-lt text-warning-ink"
      : "bg-surface-2 text-ink-3";
  return (
    <div className="flex justify-center">
      <span className={cn("flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px]", tone)}>
        {SUCCESS_EVENTS.has(event) && <CheckCircle2Icon className="size-3" aria-hidden />}
        {event === "cancellation_alert" && <TriangleAlertIcon className="size-3" aria-hidden />}
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
  const { aiReply, aiReview, original } = message.content;
  const [showOriginal, setShowOriginal] = useState(false);
  return (
    <div className="flex justify-end">
      <div className="max-w-[68%] rounded-[12px_12px_2px_12px] bg-ink px-3 py-2 text-paper">
        <MessageBody message={message} />
        {showOriginal && original && (
          <div className="mt-1.5 border-t border-ink-2 pt-1.5 text-[11.5px] leading-[1.4] whitespace-pre-wrap text-ink-3">
            Escrito pelo atendente: {original}
          </div>
        )}
        <div className="mt-[3px] text-right text-[10px] text-ink-3 tabular-nums">
          {clock(message.createdAt)}
          {message.sentBy && ` · ${message.sentBy.name.split(" ")[0]}`}
          {aiReply && (
            <span className="ml-1 inline-flex items-center gap-0.5">
              · <SparklesIcon className="size-2.5" aria-hidden /> IA
            </span>
          )}
          {aiReview === "pending" && " · revisando com IA"}
          {aiReview === "rewritten" && (
            <>
              {" · revisada pela IA · "}
              <button type="button" onClick={() => setShowOriginal((shown) => !shown)} className="underline underline-offset-2 hover:text-paper">
                {showOriginal ? "ocultar original" : "ver original"}
              </button>
            </>
          )}
          <DeliveryStatus message={message} />
        </div>
      </div>
    </div>
  );
}

/** Avaliação do atendimento pela IA, no ponto da conversa em que foi feita (só administradores recebem). */
function Evaluation({ evaluation }: { evaluation: ConversationEvaluationDto }) {
  const tone =
    evaluation.score >= 4
      ? "border-success-line bg-success-lt"
      : evaluation.score <= 2
        ? "border-tomate-line bg-tomate-lt"
        : "border-warning-line bg-warning-lt";
  const satisfaction = evaluation.satisfied === null ? "cliente sem reação" : evaluation.satisfied ? "cliente satisfeito" : "cliente insatisfeito";
  return (
    <div className={cn("mx-auto my-1 max-w-[76%] rounded-[10px] border px-3.5 py-2.5", tone)}>
      <div className="mb-1 flex items-center gap-[5px] text-[10.5px] font-semibold text-ink-2">
        <SparklesIcon className="size-3" aria-hidden />
        Avaliação da IA · <StarIcon className="size-3 fill-warning text-warning" aria-hidden />
        <span className="tabular-nums">{evaluation.score}/5</span>
        <span className="font-normal">
          · {evaluation.resolved ? "problema resolvido" : "problema não resolvido"} · {satisfaction}
        </span>
      </div>
      <div className="text-[12.5px] leading-[1.45] text-ink-2">{evaluation.summary}</div>
      <div className="mt-1 text-right text-[10px] text-ink-3 tabular-nums">
        {clock(evaluation.createdAt)}
        {evaluation.agentName ? ` · atendimento de ${evaluation.agentName.split(" ")[0]}` : " · só a IA atendeu"} · visível só para administradores
      </div>
    </div>
  );
}

function MessageBody({ message }: { message: MessageDto }) {
  const { text, location } = message.content;
  return (
    <>
      <MessageMedia message={message} />
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
