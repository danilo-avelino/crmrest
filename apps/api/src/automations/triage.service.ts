import type { Contact, TenantTx } from "@comanda/database";
import type { ChannelType, OrderStatus } from "@comanda/database/enums";
import {
  automationTextsOf,
  businessHoursOf,
  CHANNEL_CAPABILITIES,
  CHANNEL_LABEL,
  isOpenAt,
  menuMessage,
  type OrderLink,
  orderLinksMessage,
  orderLinksOf,
} from "@comanda/shared";
import { InjectQueue } from "@nestjs/bullmq";
import { Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";
import { mergeContacts } from "../contacts/contact-merge.js";
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
  DISPATCHED: "saiu para entrega",
  DELIVERED: "entregue",
  CANCELED: "cancelado",
};

// A saudação do menu e a mensagem de fora do horário vêm de Configurações (E15); estes ficam fixos.
const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

const TEXTS = {
  orderNumber: "Qual é o número do pedido? Ele aparece no aplicativo ou no comprovante.",
  orderFound: (code: string, order: FoundOrder) =>
    [
      `Encontramos o pedido #${code} (${ORDER_STATUS_TEXT[order.status]}):`,
      ...order.items.map((item) => `• ${item.quantity}x ${item.name}`),
      `Total: ${BRL.format(Number(order.total))}`,
      "",
      "É este o seu pedido?",
      "1 - Sim",
      "2 - Não",
    ].join("\n"),
  orderConfirmed: "Pedido confirmado 👍 Enquanto um atendente chega, já nos conte o problema ou a sua dúvida, assim agilizamos o atendimento.",
  orderNotFound: (code: string) => `Não encontramos o pedido #${code} entre os pedidos de hoje e de ontem. Um atendente já vai te ajudar.`,
  handoff: "Certo! Um atendente já vai falar com você.",
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

    // Conversa nova, resolvida ou parada: começa um atendimento, com o estado das automações zerado.
    if (event.newAttendance) {
      const settings = await tenantSettings(tx, conversation.tenantId);
      // Fora do horário: avisa no lugar do menu (ninguém atenderia a opção escolhida); a coleta de telefone segue.
      const hours = businessHoursOf(settings);
      if (hours.enabled && !isOpenAt(hours, new Date())) {
        const id = await automationMessage(tx, conversation, "after_hours", hours.closedMessage);
        await setAutomationState(tx, conversation.id, { triage: "done" });
        return { send: [id], done: true };
      }
      const greeting = automationTextsOf(settings).greeting;
      const id = await automationMessage(tx, conversation, "menu", menuMessage(greeting, firstName(conversation.contact.name)));
      await setAutomationState(tx, conversation.id, { triage: "awaiting_option" });
      return { send: [id], done: false };
    }
    if (state.triage === "awaiting_option") return this.chooseOption(tx, conversation, state, event.text);
    if (state.triage === "awaiting_order_number") return this.findOrder(tx, conversation, state, event.text);
    if (state.triage === "awaiting_order_confirmation") return this.confirmOrder(tx, conversation, state, event.text);
    return { send: [], done: true };
  }

  private async chooseOption(tx: TenantTx, conversation: Conversation, state: AutomationState, text?: string): Promise<Step> {
    const option = /^\s*([123])(?!\d)/.exec(text ?? "")?.[1];
    if (option === "1") {
      // Antes de pedir o número, procura o pedido mais recente (de hoje ou de ontem) ligado ao cadastro do cliente.
      const order = await this.latestOrderOf(tx, conversation.contact);
      if (order) return this.offerOrder(tx, conversation, { ...state, autoFound: true }, order, order.displayCode ?? order.externalOrderId);
      return this.askOrderNumber(tx, conversation, state);
    }

    await setAutomationState(tx, conversation.id, { ...state, triage: "done" });
    if (option === "2") {
      const links = await this.orderLinks(tx, conversation.tenantId);
      // Com os links, o cliente pede sozinho; sem eles, a equipe atende.
      if (links.length) return { send: [await automationMessage(tx, conversation, "order_links", orderLinksMessage(links))], done: true };
      return { send: [await automationMessage(tx, conversation, "handoff", TEXTS.handoff)], done: true, handoff: true };
    }
    if (option === "3") {
      return { send: [await automationMessage(tx, conversation, "handoff", TEXTS.handoff)], done: true, handoff: true };
    }
    // Outra resposta (uma pergunta, um áudio...): segue com a equipe, sem insistir no menu.
    return { send: [], done: true, handoff: true };
  }

  private async findOrder(tx: TenantTx, conversation: Conversation, state: AutomationState, text?: string): Promise<Step> {
    const finish = async (messageId: string): Promise<Step> => {
      await setAutomationState(tx, conversation.id, { ...state, triage: "done" });
      return { send: [messageId], done: true, handoff: true };
    };
    const digits = text?.match(/\d+/)?.[0];
    if (!digits) return finish(await automationMessage(tx, conversation, "handoff", TEXTS.handoff));

    const code = digits.replace(/^0+(?=\d)/, "");
    const orders = await tx.order.findMany({
      where: { displayCode: { in: [...new Set([digits, code])] }, placedAt: { gte: startOfYesterday(new Date()) } },
      include: { items: true },
      orderBy: { placedAt: "desc" },
      take: 2,
    });
    if (orders.length === 0) return finish(await automationMessage(tx, conversation, "order_lookup", TEXTS.orderNotFound(code)));
    if (orders.length > 1) {
      await systemEvent(tx, conversation, { event: "order_ambiguous", text: `Há mais de um pedido #${code} de hoje ou de ontem: confira com o cliente` });
      return finish(await automationMessage(tx, conversation, "handoff", TEXTS.handoff));
    }

    return this.offerOrder(tx, conversation, state, orders[0]!, orders[0]!.displayCode ?? code);
  }

  /**
   * Pedido mais recente de hoje ou de ontem ligado ao cadastro: do próprio cadastro (qualquer canal vinculado a ele:
   * WhatsApp, Instagram, iFood, Cardápio Web) ou de outro cadastro com o mesmo telefone, CPF ou e-mail.
   */
  private latestOrderOf(tx: TenantTx, contact: Contact) {
    const { id, phone, cpfHash, email } = contact;
    return tx.order.findFirst({
      where: {
        placedAt: { gte: startOfYesterday(new Date()) },
        OR: [
          { contactId: id },
          ...(phone ? [{ contact: { phone } }] : []),
          ...(cpfHash ? [{ contact: { cpfHash } }] : []),
          ...(email ? [{ contact: { email: { equals: email, mode: "insensitive" as const } } }] : []),
        ],
      },
      include: { items: true },
      orderBy: { placedAt: "desc" },
    });
  }

  private async askOrderNumber(tx: TenantTx, conversation: Conversation, state: AutomationState): Promise<Step> {
    const id = await automationMessage(tx, conversation, "order_number_request", TEXTS.orderNumber);
    await setAutomationState(tx, conversation.id, { ...state, triage: "awaiting_order_number", foundOrderId: undefined, autoFound: undefined });
    return { send: [id], done: false };
  }

  /** Achou: mostra os itens e pede a confirmação antes de unir os cadastros. */
  private async offerOrder(
    tx: TenantTx,
    conversation: Conversation,
    state: AutomationState,
    order: FoundOrder & { id: string },
    code: string,
  ): Promise<Step> {
    await systemEvent(tx, conversation, { event: "order", orderId: order.id });
    const messageId = await automationMessage(tx, conversation, "order_lookup", TEXTS.orderFound(code, order));
    await setAutomationState(tx, conversation.id, { ...state, triage: "awaiting_order_confirmation", foundOrderId: order.id });
    return { send: [messageId], done: false };
  }

  /**
   * "1 - Sim": o pedido é do cliente; une o cadastro da conversa ao do pedido. "2 - Não" no pedido achado pelo cadastro
   * pede o número; nos demais casos, segue com a equipe.
   */
  private async confirmOrder(tx: TenantTx, conversation: Conversation, state: AutomationState, text?: string): Promise<Step> {
    const reply = (text ?? "").trim().toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
    if (state.autoFound && /^(2(?!\d)|n(ao)?\b)/.test(reply)) return this.askOrderNumber(tx, conversation, state);
    const order =
      /^(1(?!\d)|s(im)?\b)/.test(reply) && state.foundOrderId
        ? await tx.order.findUnique({ where: { id: state.foundOrderId }, include: { contact: true, channel: { select: { type: true } } } })
        : null;
    if (!order) {
      await setAutomationState(tx, conversation.id, { ...state, triage: "done", foundOrderId: undefined, autoFound: undefined });
      return { send: [await automationMessage(tx, conversation, "handoff", TEXTS.handoff)], done: true, handoff: true };
    }
    const notify = await this.linkContact(tx, conversation, order);
    const messageId = await automationMessage(tx, conversation, "order_confirmed", TEXTS.orderConfirmed);
    await setAutomationState(tx, conversation.id, {
      ...state,
      triage: "done",
      foundOrderId: undefined,
      autoFound: undefined,
      linkedOrder: { id: order.id, at: new Date().toISOString() },
    });
    return { send: [messageId], done: true, notify, handoff: true };
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

  private async orderLinks(tx: TenantTx, tenantId: string): Promise<OrderLink[]> {
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settings: true } });
    return orderLinksOf(tenant.settings);
  }
}
