import type { TenantTx } from "@dishdesk/database";
import { automationMessagesOf, businessHoursOf, CHANNEL_CAPABILITIES, CHANNEL_LABEL, isOpenAt, type MessageContent } from "@dishdesk/shared";
import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import type { Queue } from "bullmq";
import { z } from "zod";
import { type AutomationState, automationMessage, dispatch, setAutomationState, startOfYesterday, systemEvent } from "../automations/automation.js";
import { ORDER_STATUS_TEXT } from "../automations/triage.service.js";
import { DatabaseService } from "../core/database.service.js";
import { orderUpdateMessage } from "../orders/forecast.js";
import { latestOrderOf } from "../orders/latest-order.js";
import { withOrderTenants } from "../orders/order-scope.js";
import { type OutboundJob, QUEUES } from "../queues/queues.module.js";
import { RealtimeEmitter } from "../realtime/realtime.emitter.js";
import { LlmClient } from "./llm.client.js";
import { restaurantFacts, toneOf, transcript, WRITING_RULES } from "./prompts.js";

/** Respostas da IA num atendimento; na seguinte, ela passa para a equipe sem perguntar à LLM. */
export const MAX_AI_REPLIES = 8;
/** Mensagens da conversa (das últimas 12 horas) que a IA lê antes de responder. */
const HISTORY_LIMIT = 30;
const HISTORY_MS = 12 * 60 * 60 * 1000;

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const BRASILIA_TIME = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

export const AttendantReply = z.object({
  reply: z.string().trim().min(1).max(1000).describe("A mensagem para o cliente."),
  handoff: z.boolean().describe("true = passar o atendimento para a equipe."),
  reason: z.string().max(200).describe("Para a equipe: por que passou o atendimento. Vazio quando handoff = false."),
});
type AttendantReply = z.infer<typeof AttendantReply>;

export function systemPrompt(restaurant: string, channel: string, settings: unknown): string {
  return `Você é o atendente virtual do restaurante ${restaurant} e responde clientes pelo ${channel}.
${toneOf(settings)}
${WRITING_RULES}

Você tira dúvidas sobre o horário de funcionamento, os links para fazer pedido e o andamento do pedido recente do cliente, usando só os DADOS.

Regras obrigatórias:
- Só afirme o que está nos DADOS. Nunca invente preço, cardápio, prazo, taxa, promoção, endereço ou política.
- Você não anota pedidos: para pedir, mande os links (se houver); sem links, passe para a equipe.
- Cliente perguntou de um pedido que não está nos DADOS: peça o número do pedido (e o telefone usado no pedido, se os DADOS disserem que o telefone não está no cadastro) e continue o atendimento (handoff = false). Se ele já informou e o pedido continua fora dos DADOS, passe para a equipe.
- Passe para a equipe (handoff = true) quando o cliente pedir para falar com uma pessoa; reclamar ou contar um problema com o pedido (atraso, item errado ou faltando, qualidade); falar de cancelamento, reembolso, troca ou pagamento; perguntar algo que não está nos DADOS; mandar áudio, imagem ou documento que você não consegue ver; ou quando você não tiver certeza.
- Ao passar para a equipe, diga ao cliente que alguém da equipe vai continuar o atendimento (com o restaurante fechado, diga quando ele volta a atender). Não faça perguntas nessa mensagem: quem continua é a equipe. Não prometa prazo de resposta.
- Cumprimente só na sua primeira resposta do atendimento; depois, vá direto ao ponto.`;
}

// "1234", "#1234", "pedido 1234", "Pedido Nº 1234", "pedido: 1234", "número do pedido é 1234". Números soltos no meio
// do texto ("2 pizzas", "há 30 minutos") não contam: achariam o pedido de outro cliente.
const ORDER_NUMBER = [
  /^\s*(?:pedido\s*)?#?\s*(\d{1,6})\s*[.!]?\s*$/gi,
  /pedido\s*(?:n[º°]\.?|n\.|n[uú]mero|#|:)\s*#?\s*(\d{1,6})(?!\d)/gi,
  /n[uú]mero\s+do\s+pedido\s*(?:é|e|:)?\s*#?\s*(\d{1,6})(?!\d)/gi,
];

/** Números de pedido que o cliente informou nas mensagens (com e sem os zeros à esquerda). */
export function orderNumbersIn(texts: string[]): string[] {
  const numbers = texts.flatMap((text) => ORDER_NUMBER.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[1]!)));
  return [...new Set(numbers.flatMap((number) => [number, number.replace(/^0+(?=\d)/, "")]))];
}

/** Pedido de hoje ou de ontem com o número que o cliente informou na conversa; com dois pedidos possíveis, nenhum. */
async function orderByNumber(orders: TenantTx, history: { direction: string; content: unknown }[], now: Date) {
  const codes = orderNumbersIn(history.filter((m) => m.direction === "INBOUND").map((m) => (m.content as MessageContent).text ?? ""));
  if (!codes.length) return null;
  const found = await orders.order.findMany({
    where: { displayCode: { in: codes }, placedAt: { gte: startOfYesterday(now) } },
    include: { items: true },
    orderBy: { placedAt: "desc" },
    take: 2,
  });
  return found.length === 1 ? found[0]! : null;
}

/**
 * Atendimento com IA (E27): no lugar do menu de atendimento, a LLM responde o cliente com os dados do restaurante e
 * passa para a equipe quando não pode resolver. O TriageService decide se a IA atende e agenda o job "reply" da fila ai.
 */
@Injectable()
export class AiAttendantService {
  private readonly logger = new Logger(AiAttendantService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly realtime: RealtimeEmitter,
    @InjectQueue(QUEUES.outbound) private readonly outbound: Queue<OutboundJob>,
    private readonly llm: LlmClient,
  ) {}

  /** Responde à última mensagem do cliente, se ninguém respondeu ainda (mensagens seguidas recebem uma resposta só). */
  async reply(tenantId: string, conversationId: string, now = new Date()): Promise<void> {
    const scope = { tenantIds: [tenantId] };
    const context = await this.db.withTenants(scope, async (tx) => {
      const conversation = await tx.conversation.findUniqueOrThrow({
        where: { id: conversationId },
        select: {
          id: true,
          tenantId: true,
          channelId: true,
          automationState: true,
          contact: true,
          channel: { select: { type: true } },
          tenant: { select: { name: true, settings: true } },
        },
      });
      if ((conversation.automationState as AutomationState).ai !== "on") return null;
      const history = (
        await tx.message.findMany({
          where: { conversationId, direction: { in: ["INBOUND", "OUTBOUND"] }, createdAt: { gte: new Date(now.getTime() - HISTORY_MS) } },
          orderBy: { createdAt: "desc" },
          take: HISTORY_LIMIT,
        })
      ).reverse();
      const last = history.at(-1);
      if (last?.direction !== "INBOUND") return null; // já respondida: por outro job, pela equipe ou por uma automação
      const settings = conversation.tenant.settings;
      const order = await withOrderTenants(this.db, tx, conversation.channelId, async (orders) => {
        const linked = await latestOrderOf(orders, conversation.contact, now);
        const found = linked ?? (await orderByNumber(orders, history, now));
        if (!found) return null;
        const channel = await orders.channel.findUniqueOrThrow({ where: { id: found.channelId }, select: { type: true } });
        return { ...found, byNumber: !linked, channelType: channel.type, update: await orderUpdateMessage(orders, found.id, now, settings) };
      });
      return { conversation, settings, history, lastId: last.id, order };
    });
    if (!context) return;

    const { conversation, settings } = context;
    const state = conversation.automationState as AutomationState;
    let answer: AttendantReply | null = null;
    if ((state.aiReplies ?? 0) < MAX_AI_REPLIES) {
      const order = context.order;
      const noPhone = !conversation.contact.phone && !CHANNEL_CAPABILITIES[conversation.channel.type].providesPhone;
      const orderFacts = order
        ? [
            `Pedido recente do cliente${order.byNumber ? " (achado pelo número que ele informou)" : ""}: #${order.displayCode ?? order.externalOrderId} (${CHANNEL_LABEL[order.channelType]}), feito em ${BRASILIA_TIME.format(order.placedAt)}, ${ORDER_STATUS_TEXT[order.status]}.`,
            `Itens: ${order.items.map((item) => `${item.quantity}x ${item.name}`).join("; ")}. Total: ${BRL.format(Number(order.total))}.`,
            ...(order.update ? [`Andamento: ${order.update.text}`] : []),
          ].join("\n")
        : `Pedido recente do cliente: nenhum pedido de hoje ou de ontem no cadastro nem com um número informado na conversa.${noPhone ? " O telefone do cliente não está no cadastro." : ""}`;
      try {
        answer = await this.llm.json("atendimento", AttendantReply, [
          { role: "system", content: systemPrompt(conversation.tenant.name, CHANNEL_LABEL[conversation.channel.type], settings) },
          {
            role: "user",
            content: `DADOS\n${restaurantFacts(conversation.tenant.name, settings, now)}\n${orderFacts}\n\nCONVERSA\n${transcript(context.history)}`,
          },
        ]);
      } catch (error) {
        // Sem a LLM, o cliente não fica sem resposta: a equipe é chamada.
        this.logger.warn(`IA sem resposta na conversa ${conversationId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const messageId = await this.db.withTenants(scope, async (tx) => {
      // Enquanto a LLM escrevia, o cliente mandou outra mensagem (o job dela responde) ou a equipe respondeu.
      const latest = await tx.message.findFirst({
        where: { conversationId, direction: { in: ["INBOUND", "OUTBOUND"] } },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      const current = (await tx.conversation.findUniqueOrThrow({ where: { id: conversationId }, select: { automationState: true } }))
        .automationState as AutomationState;
      if (latest?.id !== context.lastId || current.ai !== "on") return null;

      const handoff = !answer || answer.handoff;
      const id = answer
        ? (
            await tx.message.create({
              data: {
                tenantId,
                conversationId,
                channelId: conversation.channelId,
                direction: "OUTBOUND",
                type: "TEXT",
                content: { text: answer.reply, aiReply: true } satisfies MessageContent,
                status: "PENDING",
              },
              select: { id: true },
            })
          ).id
        : await automationMessage(tx, conversation, "handoff", automationMessagesOf(settings).handoff);
      const hours = businessHoursOf(settings);
      const closed = hours.enabled && !isOpenAt(hours, now);
      await setAutomationState(tx, conversationId, {
        ...current,
        ai: handoff ? "off" : "on",
        aiReplies: (current.aiReplies ?? 0) + 1,
        // Fechado: pendente até a equipe responder quando abrir, como no aviso de fora do horário.
        ...(handoff && closed && { afterHours: true }),
      });
      if (handoff) {
        const reason = answer?.reason.trim();
        await systemEvent(tx, conversation, { event: "handoff", text: `IA passou o atendimento para a equipe${reason ? `: ${reason}` : ""}` });
        await tx.conversation.update({
          where: { id: conversationId },
          data: { awaitingAgentSince: new Date(), awaitingAgentQuiet: false, ...(closed && { status: "PENDING" }) },
        });
      }
      return id;
    });
    if (messageId) await dispatch(this.outbound, this.realtime, tenantId, conversationId, [messageId]);
  }
}
