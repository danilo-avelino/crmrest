import type { Contact, TenantTx } from "@dishdesk/database";
import type { ChannelType, OrderStatus } from "@dishdesk/database/enums";
import {
  type AutomationMessages,
  automationMessagesOf,
  businessHoursOf,
  CHANNEL_CAPABILITIES,
  CHANNEL_LABEL,
  fillMessage,
  isOpenAt,
  menuMessage,
  orderLinksMessage,
  orderLinksOf,
} from "@dishdesk/shared";
import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";
import { mergeContacts } from "../contacts/contact-merge.js";
import { orderUpdateMessage } from "../orders/forecast.js";
import { latestOrderOf } from "../orders/latest-order.js";
import { DatabaseService } from "../core/database.service.js";
import { type OutboundJob, QUEUES } from "../queues/queues.module.js";
import { RealtimeEmitter } from "../realtime/realtime.emitter.js";
import {
  type AutomationState,
  automationMessage,
  dispatch,
  firstName,
  type InboundEvent,
  setAutomationState,
  startOfYesterday,
  systemEvent,
  tenantSettings,
} from "./automation.js";
import { PhoneCollectionService } from "./phone-collection.service.js";
import { SurveyService } from "./survey.service.js";

const ORDER_STATUS_TEXT: Record<OrderStatus, string> = {
  PLACED: "recebido",
  CONFIRMED: "confirmado",
  PREPARING: "em preparo",
  READY: "pronto",
  DISPATCHED: "saiu para entrega",
  DELIVERED: "entregue",
  CANCELED: "cancelado",
};

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

// Os textos vêm da personalidade do restaurante e de Configurações (E15); aqui só a montagem com os dados do pedido.
const TEXTS = {
  orderFound: (messages: AutomationMessages, code: string, order: FoundOrder) =>
    [
      fillMessage(messages.orderFound, { pedido: code, status: ORDER_STATUS_TEXT[order.status] }),
      ...order.items.map((item) => `• ${item.quantity}x ${item.name}`),
      `Total: ${BRL.format(Number(order.total))}`,
      "",
      messages.orderFoundQuestion,
      "1 - Sim",
      "2 - Não",
    ].join("\n"),
  /** Com o andamento do pedido (previsão de saída ou quando saiu), se houver. */
  orderConfirmed: (messages: AutomationMessages, update?: string) =>
    [messages.orderConfirmed, ...(update ? [update] : []), "", messages.orderFollowUp].join("\n"),
};

type Conversation = { id: string; tenantId: string; channelId: string; contact: Contact };
type FoundOrder = { status: OrderStatus; total: { toString(): string }; items: { quantity: number; name: string }[] };
/**
 * Resultado de uma etapa: mensagens a enviar, se o menu acabou, outras conversas a avisar e se o menu passou o atendimento
 * à equipe (marca o início do tempo de resposta; não vale quando a automação resolveu sozinha).
 */
type Step = { send: string[]; done: boolean; notify?: string[]; handoff?: boolean };

/**
 * Menu de atendimento do WhatsApp e do Instagram ("Em que podemos ajudar?"). "Falar sobre um pedido" pede o número,
 * acha o pedido de hoje ou de ontem (iFood, Cardápio Web) e une o cadastro da conversa ao do pedido.
 */
@Injectable()
export class TriageService {
  constructor(
    private readonly db: DatabaseService,
    private readonly realtime: RealtimeEmitter,
    @InjectQueue(QUEUES.outbound) private readonly outbound: Queue<OutboundJob>,
    private readonly phoneCollection: PhoneCollectionService,
    private readonly survey: SurveyService,
  ) {}

  /** Roda depois de cada mensagem recebida: nota da pesquisa, menu e, terminado o menu, a coleta de telefone. */
  async afterInbound(event: InboundEvent): Promise<void> {
    if (!CHANNEL_CAPABILITIES[event.channel.type].send) return;
    if (await this.survey.handleAnswer(event)) return;

    const { tenantId } = event.channel;
    const step = await this.db.withTenants({ tenantIds: [tenantId] }, async (tx) => {
      const result = await this.step(tx, event);
      if (result.handoff) {
        const conversation = await tx.conversation.findUniqueOrThrow({
          where: { id: event.conversationId },
          select: { id: true, tenantId: true, channelId: true },
        });
        await systemEvent(tx, conversation, { event: "handoff", text: "Atendimento passado para a equipe" });
        // Chamando o atendente (alarme e topo da Inbox) até alguém responder; se já chamava, vale a primeira chamada.
        await tx.conversation.updateMany({ where: { id: conversation.id, awaitingAgentSince: null }, data: { awaitingAgentSince: new Date() } });
      }
      return result;
    });
    await dispatch(this.outbound, this.realtime, tenantId, event.conversationId, step.send);
    for (const conversationId of step.notify ?? []) this.realtime.inboxChanged(tenantId, conversationId);
    if (step.done) await this.phoneCollection.afterInbound(event);
  }

  private async step(tx: TenantTx, event: InboundEvent): Promise<Step> {
    const conversation = await tx.conversation.findUniqueOrThrow({
      where: { id: event.conversationId },
      select: { id: true, tenantId: true, channelId: true, automationState: true, contact: true },
    });
    const state = conversation.automationState as AutomationState;
    const settings = await tenantSettings(tx, conversation.tenantId);
    const messages = automationMessagesOf(settings);

    // Conversa nova, resolvida ou parada: começa um atendimento, com o estado das automações zerado.
    if (event.newAttendance) {
      // Fora do horário: avisa no lugar do menu (ninguém atenderia a opção escolhida); a coleta de telefone segue.
      const hours = businessHoursOf(settings);
      if (hours.enabled && !isOpenAt(hours, new Date())) {
        const id = await automationMessage(tx, conversation, "after_hours", hours.closedMessage);
        await setAutomationState(tx, conversation.id, { triage: "done", afterHours: true });
        await this.keepPending(tx, conversation.id);
        return { send: [id], done: true };
      }
      return this.sendMenu(tx, conversation, { triage: "awaiting_option" }, messages);
    }
    if (state.triage === "awaiting_option") return this.chooseOption(tx, conversation, state, settings, event.text);
    if (state.triage === "awaiting_order_number") return this.findOrder(tx, conversation, state, messages, event.text);
    if (state.triage === "awaiting_order_confirmation") return this.confirmOrder(tx, conversation, state, messages, event.text);
    // Escreveu depois de confirmar o pedido (o problema, a dúvida): chama a equipe.
    if (state.orderFollowUp) {
      await setAutomationState(tx, conversation.id, { ...state, orderFollowUp: undefined });
      return { send: [], done: true, handoff: true };
    }
    // Mais mensagens enquanto o restaurante está fechado: a conversa continua pendente até a equipe responder.
    if (state.afterHours) {
      const hours = businessHoursOf(settings);
      if (hours.enabled && !isOpenAt(hours, new Date())) await this.keepPending(tx, conversation.id);
    }
    // Recebeu os links e continuou escrevendo: o menu volta uma vez; outra resposta fora das opções chama a equipe.
    if (state.selfServed) {
      return this.sendMenu(tx, conversation, { ...state, triage: "awaiting_option", selfServed: undefined, menuRepeated: true }, messages);
    }
    return { send: [], done: true };
  }

  /** Menu de atendimento ("Em que podemos ajudar?"), com a saudação de Configurações. */
  private async sendMenu(tx: TenantTx, conversation: Conversation, next: AutomationState, messages: AutomationMessages): Promise<Step> {
    const id = await automationMessage(tx, conversation, "menu", menuMessage(messages.greeting, firstName(conversation.contact.name)));
    await setAutomationState(tx, conversation.id, next);
    return { send: [id], done: false };
  }

  /**
   * Recebida fora do horário: pendente, para a equipe responder quando abrir. Conversa pendente não é encerrada por
   * inatividade nem pede avaliação (as duas só valem para conversas abertas ou resolvidas).
   */
  private async keepPending(tx: TenantTx, conversationId: string): Promise<void> {
    await tx.conversation.update({ where: { id: conversationId }, data: { status: "PENDING" } });
  }

  private async chooseOption(tx: TenantTx, conversation: Conversation, state: AutomationState, settings: unknown, text?: string): Promise<Step> {
    const messages = automationMessagesOf(settings);
    const option = /^\s*([123])(?!\d)/.exec(text ?? "")?.[1];
    if (option === "1") {
      // Antes de pedir o número, procura o pedido mais recente (de hoje ou de ontem) ligado ao cadastro do cliente.
      const order = await latestOrderOf(tx, conversation.contact);
      if (order) {
        return this.offerOrder(tx, conversation, { ...state, autoFound: true }, messages, order, order.displayCode ?? order.externalOrderId);
      }
      return this.askOrderNumber(tx, conversation, state, messages);
    }
    // Resposta fora das opções (uma pergunta, um áudio...): repete o menu uma vez; na segunda, chama a equipe.
    if (!option && !state.menuRepeated) return this.sendMenu(tx, conversation, { ...state, menuRepeated: true }, messages);

    if (option === "2") {
      const links = orderLinksOf(settings);
      // Com os links, o cliente pede sozinho; sem eles, a equipe atende.
      if (links.length) {
        await setAutomationState(tx, conversation.id, { ...state, triage: "done", selfServed: true });
        const text = orderLinksMessage(links, messages.orderLinks);
        return { send: [await automationMessage(tx, conversation, "order_links", text)], done: true };
      }
    }
    // Opção 3, opção 2 sem links ou a segunda resposta fora das opções: a equipe atende.
    await setAutomationState(tx, conversation.id, { ...state, triage: "done" });
    return { send: [await automationMessage(tx, conversation, "handoff", messages.handoff)], done: true, handoff: true };
  }

  private async findOrder(
    tx: TenantTx,
    conversation: Conversation,
    state: AutomationState,
    messages: AutomationMessages,
    text?: string,
  ): Promise<Step> {
    const finish = async (messageId: string): Promise<Step> => {
      await setAutomationState(tx, conversation.id, { ...state, triage: "done" });
      return { send: [messageId], done: true, handoff: true };
    };
    const digits = text?.match(/\d+/)?.[0];
    if (!digits) return finish(await automationMessage(tx, conversation, "handoff", messages.handoff));

    const code = digits.replace(/^0+(?=\d)/, "");
    const orders = await tx.order.findMany({
      where: { displayCode: { in: [...new Set([digits, code])] }, placedAt: { gte: startOfYesterday(new Date()) } },
      include: { items: true },
      orderBy: { placedAt: "desc" },
      take: 2,
    });
    if (orders.length === 0) {
      return finish(await automationMessage(tx, conversation, "order_lookup", fillMessage(messages.orderNotFound, { pedido: code })));
    }
    if (orders.length > 1) {
      await systemEvent(tx, conversation, { event: "order_ambiguous", text: `Há mais de um pedido #${code} de hoje ou de ontem: confira com o cliente` });
      return finish(await automationMessage(tx, conversation, "handoff", messages.handoff));
    }

    return this.offerOrder(tx, conversation, state, messages, orders[0]!, orders[0]!.displayCode ?? code);
  }

  private async askOrderNumber(tx: TenantTx, conversation: Conversation, state: AutomationState, messages: AutomationMessages): Promise<Step> {
    const id = await automationMessage(tx, conversation, "order_number_request", messages.orderNumberRequest);
    await setAutomationState(tx, conversation.id, { ...state, triage: "awaiting_order_number", foundOrderId: undefined, autoFound: undefined });
    return { send: [id], done: false };
  }

  /** Achou: mostra os itens e pede a confirmação antes de unir os cadastros. */
  private async offerOrder(
    tx: TenantTx,
    conversation: Conversation,
    state: AutomationState,
    messages: AutomationMessages,
    order: FoundOrder & { id: string },
    code: string,
  ): Promise<Step> {
    await systemEvent(tx, conversation, { event: "order", orderId: order.id });
    const messageId = await automationMessage(tx, conversation, "order_lookup", TEXTS.orderFound(messages, code, order));
    await setAutomationState(tx, conversation.id, { ...state, triage: "awaiting_order_confirmation", foundOrderId: order.id });
    return { send: [messageId], done: false };
  }

  /**
   * "1 - Sim": o pedido é do cliente; une o cadastro da conversa ao do pedido. "2 - Não" no pedido achado pelo cadastro
   * pede o número; nos demais casos, segue com a equipe.
   */
  private async confirmOrder(
    tx: TenantTx,
    conversation: Conversation,
    state: AutomationState,
    messages: AutomationMessages,
    text?: string,
  ): Promise<Step> {
    const reply = (text ?? "").trim().toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
    if (state.autoFound && /^(2(?!\d)|n(ao)?\b)/.test(reply)) return this.askOrderNumber(tx, conversation, state, messages);
    const order =
      /^(1(?!\d)|s(im)?\b)/.test(reply) && state.foundOrderId
        ? await tx.order.findUnique({ where: { id: state.foundOrderId }, include: { contact: true, channel: { select: { type: true } } } })
        : null;
    if (!order) {
      await setAutomationState(tx, conversation.id, { ...state, triage: "done", foundOrderId: undefined, autoFound: undefined });
      return { send: [await automationMessage(tx, conversation, "handoff", messages.handoff)], done: true, handoff: true };
    }
    const notify = await this.linkContact(tx, conversation, order);
    // Andamento: já saiu (quando) ou previsão de saída (com desculpas, se estiver atrasado).
    const update = await orderUpdateMessage(tx, order.id);
    const send = [await automationMessage(tx, conversation, "order_confirmed", TEXTS.orderConfirmed(messages, update?.text))];
    await setAutomationState(tx, conversation.id, {
      ...state,
      triage: "done",
      foundOrderId: undefined,
      autoFound: undefined,
      linkedOrder: { id: order.id, at: new Date().toISOString() },
      orderFollowUp: true,
    });
    // A equipe só é chamada se o cliente escrever de novo: o andamento do pedido pode já ter resolvido.
    return { send, done: true, notify };
  }

  /** O pedido identifica o cliente: une o cadastro da conversa ao do pedido. Devolve as outras conversas afetadas. */
  private async linkContact(
    tx: TenantTx,
    conversation: Conversation,
    order: { displayCode: string | null; contact: Contact; channel: { type: ChannelType } },
  ): Promise<string[]> {
    if (order.contact.id === conversation.contact.id) return [];
    const label = `#${order.displayCode} (${CHANNEL_LABEL[order.channel.type]})`;
    const result = await mergeContacts(tx, conversation.contact, order.contact);
    if (!result.merged) {
      await systemEvent(tx, conversation, {
        event: "merge_conflict",
        text: `O pedido ${label} está no cadastro de ${order.contact.name ?? "outro cliente"}, com ${result.conflict} diferente`,
      });
      return [];
    }
    await systemEvent(tx, conversation, { event: "contacts_merged", text: `Cadastro unificado com o do pedido ${label}` });
    const others = await tx.conversation.findMany({
      where: { contactId: result.contactId, id: { not: conversation.id } },
      select: { id: true },
    });
    return others.map((other) => other.id);
  }
}
