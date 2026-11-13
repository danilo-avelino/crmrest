import type { Prisma, TenantTx } from "@dishdesk/database";
import type { ChannelType, ConversationStatus } from "@dishdesk/database/enums";
import { CHANNEL_CAPABILITIES, type MessageContent, pausedOf } from "@dishdesk/shared";
import type { Queue } from "bullmq";
import type { Env } from "../config/env.js";
import type { DatabaseService } from "../core/database.service.js";
import type { OutboundJob } from "../queues/queues.module.js";
import type { RealtimeEmitter } from "../realtime/realtime.emitter.js";

/** Estado das automações guardado em `conversation.automationState`; zera a cada novo atendimento. */
export type AutomationState = {
  /** Menu "Em que podemos ajudar?"; as quatro últimas etapas são do menu do entregador. */
  triage?:
    | "awaiting_option"
    | "awaiting_order_number"
    | "awaiting_order_confirmation"
    | "done"
    | "awaiting_arrival_order"
    | "awaiting_front_desk_order"
    | "awaiting_problem_order"
    | "awaiting_problem";
  /** O menu já foi repetido por uma resposta fora das opções: a próxima chama a equipe. */
  menuRepeated?: boolean;
  /** Menu do entregador: o número não bateu com nenhum pedido e ele já foi pedido de novo; o próximo erro chama a equipe. */
  orderRetried?: boolean;
  /** Menu do entregador: número que ele mandou antes de escolher a opção; o aviso usa esse número, sem pedir de novo. */
  courierOrder?: string;
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
  /** O atendimento começou com o cliente voltando a escrever numa conversa resolvida: um "ok" não a reabre. */
  aiReopened?: boolean;
  /**
   * A IA precisava da equipe, mas não havia atendente (fechado, 100% automático ou ninguém online): a conversa vai para a
   * equipe quando houver (AiForwardService). Enquanto isso, a IA continua respondendo. `aiWaitingReason`: o porquê.
   */
  aiWaiting?: boolean;
  aiWaitingReason?: string;
  /** Pedido que a IA mostrou ao cliente, esperando ele confirmar que é dele. */
  aiOfferedOrderId?: string;
  /** Pedidos que a IA mostrou e o cliente disse não serem dele: ela procura outro (pelo número que ele informar). */
  aiDeniedOrderIds?: string[];
};

/**
 * Conversa em aberto que é da equipe (aba Ativos da Inbox): chamou um atendente, a equipe atuou, está pendente ou é só da
 * equipe. As demais abertas (AUTOMATIC_ONLY) só tiveram automação e ficam na aba Automáticos.
 */
export const WITH_TEAM = {
  OR: [{ teamInvolved: true }, { status: "PENDING" }, { awaitingAgentSince: { not: null } }, { teamOnly: true }],
} satisfies Prisma.ConversationWhereInput;
export const AUTOMATIC_ONLY = {
  status: "OPEN",
  teamInvolved: false,
  awaitingAgentSince: null,
  teamOnly: false,
} satisfies Prisma.ConversationWhereInput;

/** Mensagem que só a equipe atende (sem automação): a conversa vai para a aba Ativos. */
export async function leaveToTeam(db: DatabaseService, tenantId: string, conversationId: string): Promise<void> {
  await db.withTenants({ tenantIds: [tenantId] }, (tx) => tx.conversation.update({ where: { id: conversationId }, data: { teamInvolved: true } }));
}

/**
 * O cliente escreveu numa conversa que está com a equipe e nenhuma automação vai responder: o alarme toca até um
 * atendente responder (teamRepliedUpdate) ou resolver. Se já chamava, vale a primeira chamada.
 */
export async function callTeam(tx: TenantTx, conversationId: string): Promise<void> {
  await tx.conversation.updateMany({
    where: { id: conversationId, awaitingAgentSince: null },
    data: { awaitingAgentSince: new Date(), awaitingAgentQuiet: false },
  });
}

/**
 * A equipe respondeu (pelo Dish Desk ou pelo WhatsApp do celular): responder implica ter lido a conversa, e o
 * atendente assume, encerrando o menu automático (ou a IA) se ainda estiver aberto.
 */
export function teamRepliedUpdate(status: ConversationStatus, state: AutomationState) {
  const menuOpen = !!state.triage && state.triage !== "done";
  // Pendente só por ter chegado fora do horário (ou esperando um atendente): com a resposta da equipe, volta a ser um atendimento aberto.
  const afterHoursPending = status === "PENDING" && (state.afterHours || state.aiWaiting);
  return {
    unreadCount: 0,
    teamInvolved: true,
    awaitingAgentSince: null, // a equipe respondeu: o alarme para
    // Com o atendente na conversa, a próxima mensagem do cliente depois do pedido confirmado não chama a equipe.
    ...((menuOpen || afterHoursPending || state.orderFollowUp || state.ai === "on" || state.aiWaiting) && {
      automationState: {
        ...state,
        triage: "done" as const,
        afterHours: undefined,
        orderFollowUp: undefined,
        aiWaiting: undefined,
        aiWaitingReason: undefined,
        ...(state.ai === "on" && { ai: "off" as const }),
      },
    }),
    ...(afterHoursPending && { status: "OPEN" as const }),
  };
}

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

/**
 * Dish Desk pausado pelo restaurante (Configurações → Pausa): nenhuma automação nem a IA age nos canais dele. As
 * mensagens só chegam e esperam a equipe.
 */
export async function isPaused(tx: TenantTx, tenantId: string): Promise<boolean> {
  return pausedOf(await tenantSettings(tx, tenantId));
}

export function tenantPaused(db: DatabaseService, tenantId: string): Promise<boolean> {
  return db.withTenants({ tenantIds: [tenantId] }, (tx) => isPaused(tx, tenantId));
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

/**
 * O primeiro nome, para cumprimentar. O nome vem do perfil do cliente no canal: sem letras ("😃", "✨") não há nome,
 * e todo em maiúsculas ou minúsculas ("PATRICIA", "carlos") ganha só a inicial maiúscula.
 */
export function firstName(name: string | null): string | undefined {
  const first = name?.trim().split(/\s+/)[0]?.replace(/[^\p{L}'-]/gu, "") ?? "";
  if (first.length < 2) return undefined;
  const plain = first === first.toUpperCase() || first === first.toLowerCase();
  return plain ? first[0]!.toUpperCase() + first.slice(1).toLowerCase() : first;
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
