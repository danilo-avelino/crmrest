import type { TenantTx } from "@dishdesk/database";
import type { ChannelType, OrderStatus } from "@dishdesk/database/enums";
import {
  automationMessagesOf,
  businessHoursOf,
  CHANNEL_CAPABILITIES,
  CHANNEL_LABEL,
  fillMessage,
  type MessageContent,
  orderLinksOf,
} from "@dishdesk/shared";
import { InjectQueue } from "@nestjs/bullmq";
import { Injectable, Logger } from "@nestjs/common";
import type { Queue } from "bullmq";
import { z } from "zod";
import { type AutomationState, automationMessage, dispatch, setAutomationState, startOfYesterday, systemEvent } from "../automations/automation.js";
import { linkOrderContact, ORDER_STATUS_TEXT } from "../automations/triage.service.js";
import { DatabaseService } from "../core/database.service.js";
import { orderUpdateMessage } from "../orders/forecast.js";
import { latestOrderOf } from "../orders/latest-order.js";
import { withOrderTenants } from "../orders/order-scope.js";
import { type OutboundJob, QUEUES } from "../queues/queues.module.js";
import { RealtimeEmitter } from "../realtime/realtime.emitter.js";
import { PresenceService } from "../realtime/presence.service.js";
import { type Attendance, attendanceOf } from "./ai-forward.service.js";
import { LlmClient, type LlmMessage } from "./llm.client.js";
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
  order: z
    .enum(["confirmed", "denied", "none"])
    .describe(
      'Resposta do cliente à sua pergunta "é esse o seu pedido?": "confirmed" = ele respondeu que sim; "denied" = respondeu que não; "none" = você ainda não perguntou ou ele não respondeu a isso. Informar o número do pedido não é confirmar.',
    ),
});
type AttendantReply = z.infer<typeof AttendantReply>;

export function systemPrompt(restaurant: string, channel: string, settings: unknown): string {
  return `Você é o atendente virtual do restaurante ${restaurant} e responde clientes pelo ${channel}.
${toneOf(settings)}
${WRITING_RULES}

Você tira dúvidas sobre o horário de funcionamento, os links para fazer pedido e o andamento do pedido do cliente, usando só os DADOS.

Regras obrigatórias:
- Só afirme o que está nos DADOS. Nunca invente preço, cardápio, prazo, taxa, promoção, endereço ou política.
- Você não anota pedidos: para pedir, mande os links (se houver); sem links, passe para a equipe.
- Cumprimente só na sua primeira resposta do atendimento; depois, vá direto ao ponto.

Quando o cliente falar de um pedido, siga estes passos:
1. Há nos DADOS um pedido ainda não confirmado: mostre o número, os itens e o total e pergunte se é esse o pedido dele. Não diga o andamento antes de ele confirmar.
2. Ele confirmou (order = "confirmed"): diga o andamento que está nos DADOS e pergunte se pode ajudar em algo mais.
3. Ele disse que não é (order = "denied") ou não há pedido nos DADOS: peça o número do pedido (e o telefone usado no pedido, se os DADOS disserem que o telefone não está no cadastro), sem passar para a equipe.
4. Ele informou o número (e o telefone, se você pediu) e o pedido continua fora dos DADOS: passe para a equipe.

Passe para a equipe (handoff = true) só quando o cliente:
- pedir para falar com uma pessoa ou atendente, ou responder que sim quando você perguntar se ele quer;
- reclamar ou contar um problema com o pedido (atraso, item errado ou faltando, qualidade, entrega) ou pedir cancelamento, reembolso ou troca;
- perguntar sobre pagamento (chave Pix, formas de pagamento, comprovante);
- perguntar sobre o restaurante algo que não está nos DADOS nem no cardápio (entrega, taxa, endereço, promoção);
- mandar imagem, vídeo ou documento: pode ser a foto de um problema ou um comprovante de pagamento, que só a equipe consegue ver. Diga só que alguém da equipe vai ver; não peça para ele descrever.

Não passe para a equipe (handoff = false):
- Cardápio, sabores, opções (vegana, sem glúten...) ou preço: mande os links para fazer pedido, onde estão o cardápio e os preços, e continue com handoff = false (sem links, passe para a equipe).
- Áudio: diga que não consegue ouvir áudios e peça para ele escrever. Se ele mandar outro áudio, passe para a equipe.
- Mensagem sem relação com pedido ou com o restaurante (conversa solta, brincadeira, frase sem sentido): responda com educação, em poucas palavras, diga em que você pode ajudar e espere o cliente.
- O cliente agradeceu ou se despediu: despeça-se em poucas palavras, sem fazer nova pergunta.
- Você não entendeu o que o cliente quer: pergunte o que ele precisa e espere a resposta.
- Na CONVERSA, a sua última mensagem já perguntou como ajudar e o cliente respondeu sem dizer o que quer: não repita a pergunta; pergunte se ele quer falar com um atendente, com handoff = false, e espere ele responder que sim.

Mensagem de quando você passa para a equipe (handoff = true):
- Reclamação ou problema (não uma simples pergunta): comece reconhecendo o problema com empatia (ex.: lamentar o atraso), sem prometer solução, reembolso ou desconto.
- Há atendente online (veja "Atendentes" nos DADOS): diga que alguém da equipe vai continuar o atendimento, sem fazer nenhuma pergunta (quem continua é a equipe). Não diga "um momento" nem que você vai verificar: quem verifica é a equipe.
- Não há atendente: siga o que "Atendentes" diz nos DADOS e continue respondendo as outras dúvidas do cliente.`;
}

// "1234", "#1234", "é o 1234", "pedido 1234", "Pedido Nº 1234", "pedido: 1234", "número do pedido é 1234". Números
// soltos no meio do texto ("2 pizzas", "há 30 minutos") não contam: achariam o pedido de outro cliente.
const ORDER_NUMBER = [
  /^\s*(?:[ée]\s+(?:o\s+)?|o\s+)?(?:pedido\s*)?(?:n[º°]\.?\s*|n[uú]mero\s*)?#?\s*(\d{1,6})\s*[.!]?\s*$/gi,
  /pedido\s*(?:n[º°]\.?|n\.|n[uú]mero|#|:)\s*#?\s*(\d{1,6})(?!\d)/gi,
  /n[uú]mero\s+do\s+pedido\s*(?:é|e|:)?\s*#?\s*(\d{1,6})(?!\d)/gi,
  // "pedido 1234 já saiu?": o número seguido do fim da frase ou de um verbo, não de uma medida ("pedido 30 minutos atrás").
  /pedido\s+#?\s*(\d{1,6})(?=\s*$|\s*[?!.,;]|\s+(?:j[áa]|que|foi|est[áa]|t[áa]|ainda|n[ãa]o|saiu|chegou|vai|vem|e)(?![a-zà-ú]))/gi,
];

/** Números de pedido que o cliente informou nas mensagens (com e sem os zeros à esquerda). */
export function orderNumbersIn(texts: string[]): string[] {
  const numbers = texts.flatMap((text) => ORDER_NUMBER.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[1]!)));
  return [...new Set(numbers.flatMap((number) => [number, number.replace(/^0+(?=\d)/, "")]))];
}

/**
 * Pedido de hoje ou de ontem com o número que o cliente informou na conversa; com dois pedidos possíveis, nenhum.
 * `exclude`: pedidos que o cliente já disse não serem dele.
 */
async function orderByNumber(orders: TenantTx, history: { direction: string; content: unknown }[], now: Date, exclude: string[]) {
  const codes = orderNumbersIn(history.filter((m) => m.direction === "INBOUND").map((m) => (m.content as MessageContent).text ?? ""));
  if (!codes.length) return null;
  const found = await orders.order.findMany({
    where: { displayCode: { in: codes }, placedAt: { gte: startOfYesterday(now) }, id: { notIn: exclude } },
    include: { items: true },
    orderBy: { placedAt: "desc" },
    take: 2,
  });
  return found.length === 1 ? found[0]! : null;
}

export type OrderFacts = {
  displayCode: string | null;
  externalOrderId: string;
  channelType: ChannelType;
  placedAt: Date;
  status: OrderStatus;
  items: { quantity: number; name: string }[];
  total: { toString(): string };
  update: { text: string } | null;
  /** O cliente confirmou neste atendimento que o pedido é dele. */
  confirmed: boolean;
  /** Achado pelo número que o cliente informou (não pelo cadastro). */
  byNumber: boolean;
};

/** O que a LLM recebe para responder: as regras e, na mensagem do usuário, os DADOS e a CONVERSA. */
export function attendantMessages(
  restaurant: string,
  channel: ChannelType,
  settings: unknown,
  now: Date,
  orderFacts: string,
  conversation: string,
  attendance: Attendance,
): LlmMessage[] {
  const facts = [restaurantFacts(restaurant, settings, now), attendanceFacts(attendance), orderFacts].join("\n");
  return [
    { role: "system", content: systemPrompt(restaurant, CHANNEL_LABEL[channel], settings) },
    { role: "user", content: `DADOS\n${facts}\n\nCONVERSA\n${conversation}` },
  ];
}

/**
 * Se há atendente para continuar o atendimento. Sem: a IA atende sozinha e, quando o cliente precisa da equipe, avisa
 * que não há atendentes e que a conversa vai para um assim que houver (a instrução vai no próprio dado: o modelo a
 * segue melhor que uma regra condicional no prompt).
 */
function attendanceFacts(attendance: Attendance): string {
  if (attendance.available) return "Atendentes: há alguém da equipe online para continuar o atendimento.";
  const when =
    attendance.reason === "closed"
      ? `nenhum agora, porque o restaurante está fechado. Quando o cliente precisar da equipe (handoff = true), diga que no momento estamos sem atendentes, que o restaurante volta a atender ${attendance.reopening} e que a conversa será encaminhada para a equipe assim que abrir.`
      : "nenhum online agora. Quando o cliente precisar da equipe (handoff = true), diga que no momento estamos sem atendentes online e que, assim que um chegar, a conversa será encaminhada para ele.";
  return `Atendentes: ${when} Você continua atendendo sozinho: responda tudo o que puder e não diga que alguém vai falar com ele agora.`;
}

/** O pedido do cliente nos DADOS da IA: o confirmado, o candidato a confirmar (sem o andamento liberado) ou nenhum. */
export function orderFactsOf(order: OrderFacts | null, noPhone: boolean): string {
  if (!order) {
    return `Pedido do cliente: nenhum pedido de hoje ou de ontem no cadastro nem com um número informado na conversa.${noPhone ? " O telefone do cliente não está no cadastro." : ""}`;
  }
  const source = order.byNumber ? "achado pelo número que ele informou" : "ligado ao cadastro dele";
  return [
    order.confirmed ? "Pedido do cliente (ele confirmou que é dele):" : `Pedido que pode ser do cliente (${source}; ainda não confirmado por ele):`,
    `#${order.displayCode ?? order.externalOrderId} (${CHANNEL_LABEL[order.channelType]}), feito em ${BRASILIA_TIME.format(order.placedAt)}, ${ORDER_STATUS_TEXT[order.status]}.`,
    `Itens: ${order.items.map((item) => `${item.quantity}x ${item.name}`).join("; ")}. Total: ${BRL.format(Number(order.total))}.`,
    ...(order.update ? [`Andamento${order.confirmed ? "" : " (só diga depois que ele confirmar que o pedido é dele)"}: ${order.update.text}`] : []),
  ].join("\n");
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
    private readonly presence: PresenceService,
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
      const state = conversation.automationState as AutomationState;
      const denied = state.aiDeniedOrderIds ?? [];
      // O pedido que o cliente confirmou neste atendimento; senão, o candidato a confirmar: o do cadastro ou o do número informado.
      const order = await withOrderTenants(this.db, tx, conversation.channelId, async (orders) => {
        const confirmed = state.linkedOrder ? await orders.order.findUnique({ where: { id: state.linkedOrder.id }, include: { items: true } }) : null;
        const linked = confirmed ?? (await latestOrderOf(orders, conversation.contact, now, denied));
        const found = linked ?? (await orderByNumber(orders, history, now, denied));
        if (!found) return null;
        const channel = await orders.channel.findUniqueOrThrow({ where: { id: found.channelId }, select: { type: true } });
        const update = await orderUpdateMessage(orders, found.id, now, settings);
        return { ...found, confirmed: !!confirmed, byNumber: !linked, channelType: channel.type, update };
      });
      return { conversation, settings, history, lastId: last.id, order };
    });
    if (!context) return;

    const { conversation, settings } = context;
    const state = conversation.automationState as AutomationState;
    const attendance = await attendanceOf(this.presence, tenantId, settings, now);
    let answer: AttendantReply | null = null;
    // Sem atendente, a IA responde tudo: o limite de respostas só serve para chamar a equipe.
    if (!attendance.available || (state.aiReplies ?? 0) < MAX_AI_REPLIES) {
      const noPhone = !conversation.contact.phone && !CHANNEL_CAPABILITIES[conversation.channel.type].providesPhone;
      const orderFacts = orderFactsOf(context.order, noPhone);
      try {
        answer = await this.llm.json(
          "atendimento",
          AttendantReply,
          attendantMessages(conversation.tenant.name, conversation.channel.type, settings, now, orderFacts, transcript(context.history), attendance),
        );
      } catch (error) {
        // Sem a LLM, o cliente não fica sem resposta: a equipe é chamada (ou, sem atendente, a conversa espera um).
        this.logger.warn(`IA sem resposta na conversa ${conversationId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const done = await this.db.withTenants(scope, async (tx) => {
      // Enquanto a LLM escrevia, o cliente mandou outra mensagem (o job dela responde) ou a equipe respondeu.
      const latest = await tx.message.findFirst({
        where: { conversationId, direction: { in: ["INBOUND", "OUTBOUND"] } },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      const current = (await tx.conversation.findUniqueOrThrow({ where: { id: conversationId }, select: { automationState: true } }))
        .automationState as AutomationState;
      if (latest?.id !== context.lastId || current.ai !== "on") return null;

      // Com os links para pedir, o cliente segue sozinho (como a opção "Fazer um pedido" do menu): a equipe não é chamada.
      const sentLinks = !!answer && orderLinksOf(settings).some((link) => answer.reply.includes(link.url));
      // O cliente precisa da equipe (ou a LLM não respondeu). Com atendente, a IA passa a conversa e sai; sem, ela continua
      // atendendo e a conversa espera alguém (aiWaiting).
      const needsTeam = !answer || (answer.handoff && !sentLinks);
      const handoff = needsTeam && attendance.available;
      const waits = needsTeam && !attendance.available;
      const startsWaiting = waits && !current.aiWaiting;
      // A conversa começa a esperar, mas a resposta não avisa o cliente (fechado: sem a hora em que o restaurante volta).
      const hours = businessHoursOf(settings);
      const reopening = attendance.available ? undefined : attendance.reopening?.match(/\d\d:\d\d/)?.[0];
      const noNotice = startsWaiting && !!answer && (reopening ? !answer.reply.includes(reopening) : !/atendente/i.test(answer.reply));
      // Mensagem automática no lugar da resposta: sem resposta da LLM; passando para a equipe com uma pergunta (que ninguém
      // leria); ou sem o aviso de que não há atendente, sem estar perguntando nada. Se a IA pergunta algo (ex.: o número do
      // pedido), a resposta sai e o aviso vai logo depois.
      const unfit = !!answer && ((handoff && answer.reply.includes("?")) || (noNotice && !answer.reply.includes("?")));
      const appendNotice = noNotice && !unfit;
      const reply = answer && !unfit ? answer.reply : null;
      const messages = automationMessagesOf(settings);
      const notice = () =>
        attendance.available
          ? Promise.resolve(null)
          : attendance.reason === "closed"
            ? automationMessage(tx, conversation, "after_hours", fillMessage(hours.closedMessage, { retorno: attendance.reopening ?? "" }))
            : automationMessage(tx, conversation, "no_agents_online", messages.noAgentsOnline);
      const id = reply
        ? (
            await tx.message.create({
              data: {
                tenantId,
                conversationId,
                channelId: conversation.channelId,
                direction: "OUTBOUND",
                type: "TEXT",
                content: { text: reply, aiReply: true } satisfies MessageContent,
                status: "PENDING",
              },
              select: { id: true },
            })
          ).id
        : attendance.available
          ? await automationMessage(tx, conversation, "handoff", messages.handoff)
          : (await notice())!;
      const extra = appendNotice ? await notice() : null;
      // Como no menu: a IA mostra o pedido (a resposta cita o número) e a resposta seguinte do cliente confirma ou não.
      // "É meu" une o cadastro ao do pedido; "não é" faz a IA procurar outro.
      const pending = context.order && !context.order.confirmed ? context.order : null;
      const offered = !!pending && current.aiOfferedOrderId === pending.id;
      const confirmed = pending && offered && answer?.order === "confirmed" ? pending.id : null;
      const deniedId = pending && offered && answer?.order === "denied" ? pending.id : null;
      const code = (pending?.displayCode ?? pending?.externalOrderId ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const offers = !!pending && !confirmed && !deniedId && !!answer && new RegExp(`(?<!\\d)${code}(?!\\d)`).test(answer.reply);
      const notify = confirmed ? await this.confirmOrder(tx, conversationId, confirmed) : [];
      const reason = answer?.reason.trim() || undefined;
      await setAutomationState(tx, conversationId, {
        ...current,
        ai: handoff ? "off" : "on",
        aiReplies: (current.aiReplies ?? 0) + 1,
        ...(startsWaiting && { aiWaiting: true, aiWaitingReason: reason }),
        ...(confirmed && { linkedOrder: { id: confirmed, at: now.toISOString() } }),
        ...(deniedId && { aiDeniedOrderIds: [...(current.aiDeniedOrderIds ?? []), deniedId] }),
        ...(offers && pending && { aiOfferedOrderId: pending.id }),
      });
      if (handoff) {
        await systemEvent(tx, conversation, { event: "handoff", text: `IA passou o atendimento para a equipe${reason ? `: ${reason}` : ""}` });
        await tx.conversation.update({ where: { id: conversationId }, data: { awaitingAgentSince: new Date(), awaitingAgentQuiet: false } });
      }
      if (startsWaiting && !attendance.available) {
        const why = { closed: "o restaurante está fechado", full_auto: "o 100% automático está ligado", offline: "não há atendente online" }[attendance.reason];
        await systemEvent(tx, conversation, {
          event: "awaiting_agent",
          waitingReason: attendance.reason,
          text:`Cliente precisa da equipe${reason ? ` (${reason})` : ""}, mas ${why}: a conversa vai para a equipe quando houver atendente`,
        });
        // Pendente: não é encerrada por inatividade enquanto espera.
        await tx.conversation.update({ where: { id: conversationId }, data: { status: "PENDING" } });
      }
      return { ids: extra ? [id, extra] : [id], notify, startsWaiting };
    });
    if (!done) return;
    if (done.startsWaiting) await this.presence.markWaiting(tenantId);
    await dispatch(this.outbound, this.realtime, tenantId, conversationId, done.ids);
    for (const other of done.notify) this.realtime.inboxChanged(tenantId, other);
  }

  /** O cliente confirmou o pedido: o card dele entra na conversa e o cadastro é unido ao do pedido. Devolve as outras conversas afetadas. */
  private async confirmOrder(tx: TenantTx, conversationId: string, orderId: string): Promise<string[]> {
    const conversation = await tx.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { id: true, tenantId: true, channelId: true, contact: true },
    });
    const order = await withOrderTenants(this.db, tx, conversation.channelId, (orders) =>
      orders.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { contact: true, channel: { select: { type: true } }, tenant: { select: { name: true } } },
      }),
    );
    await systemEvent(tx, conversation, { event: "order", orderId });
    return linkOrderContact(tx, conversation, order);
  }
}
