"use client";

import { type ConversationEvaluationDto, type ConversationMessages, type MessageContent, type MessageDto, TEAM_REASONS } from "@dishdesk/shared";
import {
  AlertCircleIcon,
  ArrowDownIcon,
  CheckCircle2Icon,
  ClockIcon,
  ForwardIcon,
  LockIcon,
  MapPinIcon,
  SparklesIcon,
  StickyNoteIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/auth/auth-provider";
import { Avatar } from "@/components/inbox/bits";
import { canForward, ForwardDialog } from "@/components/inbox/forward-dialog";
import { MessageMedia } from "@/components/inbox/message-media";
import { OrderCard } from "@/components/inbox/order-card";
import { AiScoreBadge, evaluationNotes, Pill } from "@/components/reports/report-ui";
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
  order_canceled: "Automação · cancelamento do pedido",
  order_links: "Automação · links para pedir",
  handoff: "Automação · encaminhado à equipe",
  no_agents_online: "Automação · sem atendentes online",
  survey: "Automação · pesquisa de satisfação",
  survey_thanks: "Automação · avaliação recebida",
  after_hours: "Automação · fora do horário",
  inactivity_close: "Automação · encerrada por inatividade",
  courier_menu: "Automação · menu do entregador",
  courier_arrival: "Automação · entregador chegou",
  courier_arrival_confirmed: "Automação · cliente avisado da chegada",
  courier_front_desk: "Automação · deixado na portaria",
  courier_front_desk_confirmed: "Automação · cliente avisado da portaria",
  courier_problem_request: "Automação · problema com o pedido",
};

const SUCCESS_EVENTS = new Set<MessageContent["event"]>(["phone_collected", "contacts_merged", "rating"]);
/** Prevenção de fraude: pílula com cadeado, a hora e, no que chama atenção, o tom do alerta. */
const FRAUD_TEAM_EVENTS = new Set<MessageContent["event"]>(["fraud_alert", "order_kept", "order_canceled_by_team", "order_cancel_refused", "fraud_marked", "fraud_unmarked"]);
const FRAUD_HOT_EVENTS = new Set<MessageContent["event"]>(["fraud_alert", "order_canceled_by_team", "order_cancel_refused", "fraud_marked"]);
const WARNING_EVENTS = new Set<MessageContent["event"]>(["phone_pending", "opt_out", "merge_conflict", "possible_duplicate", "order_ambiguous", "awaiting_agent", "ai_fallback"]);

const DAY_MS = 24 * 60 * 60_000;
const weekday = new Intl.DateTimeFormat("pt-BR", { weekday: "long" });
const fullDate = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
const dayKey = (iso: string) => new Date(iso).toDateString();

/** Separador de dia da conversa: "Hoje", "Ontem", o dia da semana nesta semana ou a data. */
function dayHeading(iso: string): string {
  const day = new Date(iso);
  const today = new Date();
  const days = Math.round((new Date(today.toDateString()).getTime() - new Date(day.toDateString()).getTime()) / DAY_MS);
  if (days === 0) return "Hoje";
  if (days === 1) return "Ontem";
  if (days < 7) {
    const name = weekday.format(day);
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
  return fullDate.format(day);
}

/** Mensagens seguidas do cliente (ou da mesma pessoa da equipe), em até 5 min, ficam juntas. */
function sameSender(a: MessageDto | undefined, b: MessageDto | undefined): boolean {
  if (!a || !b || a.type === "SYSTEM" || b.type === "SYSTEM" || a.type === "NOTE" || b.type === "NOTE") return false;
  if (a.content.automation || b.content.automation || a.direction !== b.direction || dayKey(a.createdAt) !== dayKey(b.createdAt)) return false;
  if (a.direction === "OUTBOUND" && (a.sentBy?.id !== b.sentBy?.id || Boolean(a.content.aiReply) !== Boolean(b.content.aiReply))) return false;
  return Math.abs(new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()) < 5 * 60_000;
}

/**
 * Linha do tempo da conversa: mensagens, eventos, notas e pedidos (board Inbox → "Mensagens"), numa coluna de leitura,
 * com o dia entre as mensagens. Quem está lendo o começo não é levado ao fim quando chega mensagem: aparece o aviso.
 */
export function MessageTimeline({
  data,
  contact,
  tenantId,
  onOpenConversation,
}: {
  data: ConversationMessages;
  contact: { id: string; name: string | null };
  /** Restaurante da conversa: o encaminhar só lista conversas dele. */
  tenantId: string;
  /** Abre outra conversa na Inbox (botão de conversar com o cliente, no card do pedido). */
  onOpenConversation: (id: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const seen = useRef<string | undefined>(undefined);
  const [unseen, setUnseen] = useState(0);
  const [forwarding, setForwarding] = useState<MessageDto | null>(null);
  const lastMessage = data.messages.at(-1);
  const last = lastMessage?.id;

  const toBottom = () => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
    atBottom.current = true;
    setUnseen(0);
  };
  useEffect(() => {
    if (last === seen.current) return;
    const first = seen.current === undefined;
    seen.current = last;
    // A resposta que a própria equipe mandou sempre leva ao fim; a do cliente, só se o atendente já estava lá.
    if (first || atBottom.current || lastMessage?.direction !== "INBOUND") toBottom();
    else setUnseen((count) => count + 1);
  }, [last, lastMessage?.direction]);

  // Cards de pedido e imagens terminam de carregar depois: quem está no fim continua no fim.
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = content.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      if (atBottom.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Cada avaliação da IA entra depois da última mensagem anterior a ela.
  const evaluationsAfter = new Map<string, ConversationEvaluationDto[]>();
  const leading: ConversationEvaluationDto[] = [];
  for (const evaluation of data.evaluations) {
    const before = data.messages.findLast((message) => message.createdAt <= evaluation.createdAt);
    if (!before) leading.push(evaluation);
    else evaluationsAfter.set(before.id, [...(evaluationsAfter.get(before.id) ?? []), evaluation]);
  }

  return (
    <div className="relative flex min-h-0 flex-1">
      <div
        ref={scroller}
        role="log"
        aria-label="Mensagens da conversa"
        onScroll={(event) => {
          const element = event.currentTarget;
          atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
          if (atBottom.current && unseen > 0) setUnseen(0);
        }}
        className="flex-1 overflow-y-auto px-5 pt-5 pb-3"
      >
        <div ref={content} className="mx-auto flex w-full max-w-[760px] flex-col gap-2.5">
          {leading.map((evaluation) => (
            <Evaluation key={evaluation.id} evaluation={evaluation} />
          ))}
          {data.messages.map((message, index) => {
            const previous = data.messages[index - 1];
            const next = data.messages[index + 1];
            return (
              <Fragment key={message.id}>
                {(!previous || dayKey(previous.createdAt) !== dayKey(message.createdAt)) && (
                  <div className="my-1 flex items-center gap-3 text-[11px] font-medium text-ink-3 before:h-px before:flex-1 before:bg-rule after:h-px after:flex-1 after:bg-rule">
                    {dayHeading(message.createdAt)}
                  </div>
                )}
                <TimelineMessage
                  message={message}
                  data={data}
                  contact={contact}
                  grouped={{ withPrevious: sameSender(previous, message), withNext: sameSender(message, next) }}
                  onForward={canForward(message) ? () => setForwarding(message) : undefined}
                  onOpenConversation={onOpenConversation}
                />
                {evaluationsAfter.get(message.id)?.map((evaluation) => <Evaluation key={evaluation.id} evaluation={evaluation} />)}
              </Fragment>
            );
          })}
        </div>
      </div>
      {unseen > 0 && (
        <button
          type="button"
          onClick={toBottom}
          className="absolute bottom-3 left-1/2 flex h-[30px] -translate-x-1/2 items-center gap-1.5 rounded-full bg-ink px-3 text-[12px] font-medium text-paper shadow-md"
        >
          {unseen === 1 ? "1 nova mensagem" : `${unseen} novas mensagens`}
          <ArrowDownIcon className="size-3.5" aria-hidden />
        </button>
      )}
      <ForwardDialog message={forwarding} tenantId={tenantId} onClose={() => setForwarding(null)} />
    </div>
  );
}

type Grouped = { withPrevious: boolean; withNext: boolean };

/** Botão de encaminhar ao lado do balão; aparece ao passar o mouse na mensagem. */
function ForwardButton({ onForward }: { onForward: () => void }) {
  return (
    <button
      type="button"
      onClick={onForward}
      title="Encaminhar"
      aria-label="Encaminhar mensagem"
      className="flex size-7 shrink-0 items-center justify-center self-center rounded-full border border-rule bg-surface text-ink-2 opacity-0 shadow-sm group-hover/message:opacity-100 hover:bg-surface-2 hover:text-ink focus-visible:opacity-100"
    >
      <ForwardIcon className="size-3.5" aria-hidden />
    </button>
  );
}

function TimelineMessage({
  message,
  data,
  contact,
  grouped,
  onForward,
  onOpenConversation,
}: {
  message: MessageDto;
  data: ConversationMessages;
  contact: { id: string; name: string | null };
  grouped: Grouped;
  onForward?: () => void;
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
  if (message.content.aiReview === "blocked") return <Misconduct message={message} />;
  if (message.content.automation) return <Automation message={message} />;
  return message.direction === "INBOUND" ? (
    <Inbound message={message} contact={contact} grouped={grouped} onForward={onForward} />
  ) : (
    <Outbound message={message} grouped={grouped} onForward={onForward} />
  );
}

function SystemEvent({ message }: { message: MessageDto }) {
  const { event, text } = message.content;
  const tone = SUCCESS_EVENTS.has(event)
    ? "border border-success-line bg-success-lt text-success-ink"
    : event === "cancellation_alert"
      ? "border border-tomate-line bg-tomate-lt font-semibold text-tomate"
      : FRAUD_HOT_EVENTS.has(event)
      ? "border border-tomate-line bg-tomate-lt text-tomate-ink"
      : event === "order_kept"
      ? "border border-success-line bg-success-lt text-success-ink"
      : WARNING_EVENTS.has(event)
      ? "border border-warning-line bg-warning-lt text-warning-ink"
      : "bg-surface-2 text-ink-3";
  return (
    <div className="flex justify-center">
      <span className={cn("flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px]", tone)}>
        {SUCCESS_EVENTS.has(event) && <CheckCircle2Icon className="size-3" aria-hidden />}
        {event === "cancellation_alert" && <TriangleAlertIcon className="size-3" aria-hidden />}
        {FRAUD_TEAM_EVENTS.has(event) && <LockIcon className="size-3" aria-label="Só a equipe vê" />}
        {text}
        {event === "conversation_opened" && ` · ${weekdayClock(message.createdAt)}`}
        {FRAUD_TEAM_EVENTS.has(event) && ` · ${clock(message.createdAt)}`}
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

/** Resposta do atendente bloqueada pela revisão da IA por má conduta: não foi ao cliente e vai para as Avaliações do gestor. */
function Misconduct({ message }: { message: MessageDto }) {
  return (
    <div className="mx-auto my-1 max-w-[76%] rounded-[10px] border border-tomate-line bg-tomate-lt px-3.5 py-2.5">
      <div className="mb-1 flex items-center gap-[5px] text-[10.5px] font-semibold text-tomate">
        <TriangleAlertIcon className="size-3" aria-hidden />
        Mensagem não enviada · má conduta no atendimento
      </div>
      <div className="text-[12.5px] leading-[1.45] text-ink-2">
        A IA considerou esta resposta uma má conduta no atendimento. Ela não foi enviada ao cliente e será enviada ao gestor do
        restaurante.
      </div>
      <div className="mt-1 text-[11.5px] leading-[1.4] text-tomate">Motivo: {message.content.misconduct}</div>
      <div className="mt-1.5 border-t border-tomate-line pt-1.5 text-[11.5px] leading-[1.4] whitespace-pre-wrap text-ink-3">
        Escrito pelo atendente: {message.content.original}
      </div>
      <div className="mt-1 text-right text-[10px] text-ink-3 tabular-nums">
        {clock(message.createdAt)}
        {message.sentBy && ` · ${message.sentBy.name.split(" ")[0]}`} · visível só para a equipe
      </div>
    </div>
  );
}

function Inbound({
  message,
  contact,
  grouped,
  onForward,
}: {
  message: MessageDto;
  contact: { id: string; name: string | null };
  grouped: Grouped;
  onForward?: () => void;
}) {
  return (
    <div className={cn("group/message flex max-w-[78%] items-end gap-[7px]", grouped.withPrevious && "-mt-1.5")}>
      {/* A foto do cliente fica só na última mensagem do grupo. */}
      {grouped.withNext ? <span className="w-[22px] shrink-0" /> : <Avatar seed={contact.id} name={contact.name} className="size-[22px] text-[8px]" />}
      <div className={cn("min-w-0 border border-rule bg-surface px-3 py-2", grouped.withNext ? "rounded-[12px]" : "rounded-[12px_12px_12px_2px]")}>
        <MessageBody message={message} />
        <div className="mt-[3px] text-right text-[10px] text-ink-3 tabular-nums">{clock(message.createdAt)}</div>
      </div>
      {onForward && <ForwardButton onForward={onForward} />}
    </div>
  );
}

function Outbound({ message, grouped, onForward }: { message: MessageDto; grouped: Grouped; onForward?: () => void }) {
  const { aiReply, aiReview, original, fromPhone, forwarded } = message.content;
  const [showOriginal, setShowOriginal] = useState(false);
  return (
    <div className={cn("group/message flex items-end justify-end gap-[7px]", grouped.withPrevious && "-mt-1.5")}>
      {onForward && <ForwardButton onForward={onForward} />}
      <div className={cn("min-w-0 max-w-[74%] bg-ink px-3 py-2 text-paper", grouped.withNext ? "rounded-[12px]" : "rounded-[12px_12px_2px_12px]")}>
        {forwarded && (
          <div className="mb-[3px] flex items-center gap-1 text-[10.5px] text-ink-3 italic">
            <ForwardIcon className="size-[11px]" aria-hidden />
            Encaminhada
          </div>
        )}
        <MessageBody message={message} />
        {showOriginal && original && (
          <div className="mt-1.5 border-t border-ink-2 pt-1.5 text-[11.5px] leading-[1.4] whitespace-pre-wrap text-ink-3">
            Escrito pelo atendente: {original}
          </div>
        )}
        <div className="mt-[3px] text-right text-[10px] text-ink-3 tabular-nums">
          {clock(message.createdAt)}
          {message.sentBy && ` · ${message.sentBy.name.split(" ")[0]}`}
          {fromPhone && " · pelo celular"}
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
  return (
    <div className="mx-auto my-1 w-full max-w-[76%] rounded-2xl border border-rule-soft bg-surface px-4 py-3.5">
      <div className="flex items-center gap-2.5">
        <AiScoreBadge value={evaluation.score} />
        <span className="text-[13px] font-semibold">Avaliação da IA</span>
        <div className="flex-1" />
        {evaluation.resolved ? <Pill tone="success">Resolvido</Pill> : <Pill tone="danger">Não resolvido</Pill>}
        {evaluation.satisfied === null ? (
          <Pill tone="neutral">Sem reação</Pill>
        ) : evaluation.satisfied ? (
          <Pill tone="success">Satisfeito</Pill>
        ) : (
          <Pill tone="danger">Insatisfeito</Pill>
        )}
        {evaluation.teamReason && <Pill tone="warning">{TEAM_REASONS[evaluation.teamReason]}</Pill>}
      </div>
      {evaluationNotes(evaluation).length > 0 && <div className="mt-2.5 text-[12.5px] leading-[1.5] text-ink-2">{evaluationNotes(evaluation).join(" · ")}</div>}
      {evaluation.summary && <div className="mt-2.5 text-[13px] leading-[1.5] text-ink-2">{evaluation.summary}</div>}
      <div className="mt-2 text-xs text-ink-3 tabular-nums">
        {evaluation.agentName ? `Atendido por ${evaluation.agentName}` : "Só a IA atendeu"} · {clock(evaluation.createdAt)}
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
          className="group/location flex items-start gap-1.5 font-medium"
        >
          <MapPinIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            <span className="underline-offset-2 group-hover/location:underline">{location.name ?? location.address ?? "Localização"}</span>
            <small className="block text-[11px] font-normal opacity-70">Abrir no mapa</small>
          </span>
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
        <span className="ml-1 inline-flex items-center gap-0.5 text-[#F5B5AC] dark:text-tomate-ink" title={message.statusError ?? undefined}>
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
