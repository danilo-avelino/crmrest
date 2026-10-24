import type { TenantTx } from "@dishdesk/database";
import type { ChannelType, ConversationStatus } from "@dishdesk/database/enums";
import { CHANNEL_CAPABILITIES, type MessageContent } from "@dishdesk/shared";
import type { Queue } from "bullmq";
import type { Env } from "../config/env.js";
import type { OutboundJob } from "../queues/queues.module.js";
import type { RealtimeEmitter } from "../realtime/realtime.emitter.js";

/** Estado das automações guardado em `conversation.automationState`; zera a cada novo atendimento. */
export type AutomationState = {
  /** Menu "Em que podemos ajudar?"; as três últimas etapas são do menu do entregador. */
  triage?:
    | "awaiting_option"
    | "awaiting_order_number"
    | "awaiting_order_confirmation"
    | "done"
    | "awaiting_arrival_order"
    | "awaiting_problem_order"
    | "awaiting_problem";
  /** O menu já foi repetido por uma resposta fora das opções: a próxima chama a equipe. */
  menuRepeated?: boolean;
  /** O cliente recebeu os links e pediu sozinho; se continuar escrevendo, o menu volta uma vez. */
  selfServed?: boolean;
  /** O atendimento começou com o restaurante fechado (aviso de fora do horário no lugar do menu). */
  afterHours?: boolean;  /** Pedido achado pelo número, esperando o cliente confirmar que é dele. */
  foundOrderId?: string;
  /** O pedido foi achado pelo cadastro do cliente (sem ele informar o número): "não" pede o número. */
  autoFound?: boolean;
  /** Pedido confirmado pelo cliente neste atendimento (decide a pesquisa de satisfação). */
  linkedOrder?: { id: string; at: string };
  /** Pedido confirmado e andamento enviado: a próxima mensagem do cliente chama a equipe. */
  orderFollowUp?: boolean;
  /** Coleta de telefone (§5.3). */
  phoneCollection?: "awaiting_phone" | "phone_collected" | "phone_skipped";
  phoneReminderSentAt?: string;
  /** Pesquisa de satisfação no fim do atendimento. */
  survey?: "awaiting_rating" | "answered" | "skipped";
  /** Atendimento com IA no lugar do menu: "on" = a IA responde; "off" = passou para a equipe ou a equipe assumiu. */
  ai?: "on" | "off";
  /** Respostas da IA neste atendimento (o limite chama a equipe). */
  aiReplies?: number;
  /** Pedido que a IA mostrou ao cliente, esperando ele confirmar que é dele. */
  aiOfferedOrderId?: string;
  /** Pedidos que a IA mostrou e o cliente disse não serem dele: ela procura outro (pelo número que ele informar). */
  aiDeniedOrderIds?: string[];
};

/** Resposta à pesquisa de satisfação: só a nota, de 1 a 5. */
export const RATING_ANSWER = /^\s*([1-5])\s*$/;

/** Mensagem recebida, como as automações a veem. */
export type InboundEvent = {
  channel: { id: string; tenantId: string; type: ChannelType };
  conversationId: string;
  /** Status da conversa antes desta mensagem; null = conversa nova. */
  previousStatus: ConversationStatus | null;
  /** Começa um atendimento: conversa nova, resolvida ou sem interação há 20 minutos. */
  newAttendance: boolean;
  text?: string;
};

type ConversationRef = { id: string; tenantId: string; channelId: string };

/** O canal aceita envios do Dish Desk? O iFood, só com a trava do chat ligada: quem envia é o painel, pela extensão. */
export function channelSends(type: ChannelType, env: Pick<Env, "IFOOD_CHAT_BRIDGE">): boolean {
  return CHANNEL_CAPABILITIES[type].send || (type === "IFOOD" && env.IFOOD_CHAT_BRIDGE);
}

/** `tenant.settings` do restaurante (textos automáticos, horário, links de pedido), como o admin salvou. */
export async function tenantSettings(tx: TenantTx, tenantId: string): Promise<unknown> {
  return (await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settings: true } })).settings;
}

export async function setAutomationState(tx: TenantTx, conversationId: string, state: AutomationState): Promise<void> {
  await tx.conversation.update({ where: { id: conversationId }, data: { automationState: state } });
}

/** Mensagem automática para o cliente, gravada como pendente: o envio sai por `dispatch`. */
export async function automationMessage(
  tx: TenantTx,
  conversation: ConversationRef,
  automation: NonNullable<MessageContent["automation"]>,
  text: string,
): Promise<string> {
  const message = await tx.message.create({
    data: {
      tenantId: conversation.tenantId,
      conversationId: conversation.id,
      channelId: conversation.channelId,
      direction: "OUTBOUND",
      type: "TEXT",
      content: { text, automation } satisfies MessageContent,
      status: "PENDING",
    },
    select: { id: true },
  });
  return message.id;
}

/** Evento do sistema na linha do tempo (só a equipe vê). */
export async function systemEvent(
  tx: TenantTx,
  conversation: ConversationRef,
  content: MessageContent & { event: NonNullable<MessageContent["event"]> },
): Promise<void> {
  await tx.message.create({
    data: {
      tenantId: conversation.tenantId,
      conversationId: conversation.id,
      channelId: conversation.channelId,
      direction: "INTERNAL",
      type: "SYSTEM",
      content,
    },
  });
}

/** Enfileira os envios e avisa os painéis. */
export async function dispatch(
  outbound: Queue<OutboundJob>,
  realtime: RealtimeEmitter,
  tenantId: string,
  conversationId: string,
  messageIds: string[],
): Promise<void> {
  for (const messageId of messageIds) await outbound.add("send", { tenantId, messageId });
  realtime.inboxChanged(tenantId, conversationId);
}

export function firstName(name: string | null): string | undefined {
  return name?.trim().split(/\s+/)[0] || undefined;
}

const BRASILIA = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" });

/** Data (AAAA-MM-DD) no horário de Brasília, que define "hoje" para os restaurantes. */
export function localDate(at: Date): string {
  return BRASILIA.format(at);
}

/** 00h de ontem em Brasília (sem horário de verão desde 2019): a busca vale para pedidos de hoje e de ontem. */
export function startOfYesterday(now: Date): Date {
  return new Date(Date.parse(`${localDate(now)}T00:00:00-03:00`) - 24 * 60 * 60 * 1000);
}
