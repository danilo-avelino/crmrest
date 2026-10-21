import type { Contact, TenantTx } from "@dishdesk/database";
import { type AutomationMessages, automationMessagesOf, COURIER_MENU_OPTIONS, fillMessage, menuMessage } from "@dishdesk/shared";
import { Inject, Injectable } from "@nestjs/common";
import { ENV, type Env } from "../config/env.js";
import { openIfoodConversation } from "../conversations/ifood-conversation.js";
import { DatabaseService } from "../core/database.service.js";
import { withOrderTenants } from "../orders/order-scope.js";
import {
  type AutomationState,
  automationMessage,
  firstName,
  type InboundEvent,
  setAutomationState,
  startOfYesterday,
  systemEvent,
  tenantSettings,
} from "./automation.js";
import type { Step } from "./triage.service.js";

type Conversation = { id: string; tenantId: string; channelId: string; automationState: unknown; contact: Contact };

/**
 * Menu de quem tem a tag Entregador, no lugar do menu de atendimento (sem aviso de fora do horário nem coleta de telefone):
 * avisar o cliente que chegou (pelo chat do iFood do pedido), relatar um problema com um pedido ou falar de outro assunto.
 * Só o problema relatado chama a equipe com o alarme; nos outros casos, o chamado é sem urgência. O pedido é procurado
 * também nos restaurantes que o canal atende (o WhatsApp de um grupo; Configurações → Integrações).
 */
@Injectable()
export class CourierMenuService {
  constructor(
    private readonly db: DatabaseService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async step(tx: TenantTx, conversation: Conversation, event: InboundEvent): Promise<Step> {
    const messages = automationMessagesOf(await tenantSettings(tx, conversation.tenantId));
    const state = conversation.automationState as AutomationState;
    if (event.newAttendance) return this.sendMenu(tx, conversation, { triage: "awaiting_option" }, messages);
    if (state.triage === "awaiting_option") return this.chooseOption(tx, conversation, state, messages, event.text);
    if (state.triage === "awaiting_arrival_order") return this.notifyArrival(tx, conversation, state, messages, event.text);
    if (state.triage === "awaiting_problem_order") return this.findProblemOrder(tx, conversation, state, messages, event.text);
    if (state.triage === "awaiting_problem") {
      const id = await automationMessage(tx, conversation, "handoff", messages.courierProblemForwarded);
      await setAutomationState(tx, conversation.id, { ...state, triage: "done" });
      return { send: [id], done: false, handoff: true, handoffText: "Entregador relatou um problema com um pedido" };
    }
    return { send: [], done: false };
  }

  private async sendMenu(tx: TenantTx, conversation: Conversation, next: AutomationState, messages: AutomationMessages): Promise<Step> {
    const text = menuMessage(messages.courierGreeting, firstName(conversation.contact.name), COURIER_MENU_OPTIONS);
    const id = await automationMessage(tx, conversation, "courier_menu", text);
    await setAutomationState(tx, conversation.id, next);
    return { send: [id], done: false };
  }

  private async chooseOption(tx: TenantTx, conversation: Conversation, state: AutomationState, messages: AutomationMessages, text?: string): Promise<Step> {
    const option = /^\s*([123])(?!\d)/.exec(text ?? "")?.[1];
    if (option === "1" || option === "2") {
      const id = await automationMessage(tx, conversation, "order_number_request", messages.courierOrderNumberRequest);
      await setAutomationState(tx, conversation.id, { ...state, triage: option === "1" ? "awaiting_arrival_order" : "awaiting_problem_order" });
      return { send: [id], done: false };
    }
    // Resposta fora das opções: repete o menu uma vez; na segunda, chama a equipe.
    if (!option && !state.menuRepeated) return this.sendMenu(tx, conversation, { ...state, menuRepeated: true }, messages);
    return this.callTeam(tx, conversation, state, await automationMessage(tx, conversation, "handoff", messages.handoff), "Entregador chamando");
  }

  /** "Avisar que cheguei": o aviso vai para o cliente no chat do iFood do pedido e o atendimento do entregador se resolve sozinho. */
  private async notifyArrival(tx: TenantTx, conversation: Conversation, state: AutomationState, messages: AutomationMessages, text?: string): Promise<Step> {
    const found = await this.findOrder(tx, conversation, text, true);
    // Sem o pedido (ou sem o chat do iFood na Inbox), é a equipe que avisa o cliente.
    if (!found?.order || !this.env.IFOOD_CHAT_BRIDGE) {
      const note = found ? `Entregador avisou que chegou com o pedido #${found.code}` : "Entregador avisou que chegou";
      return this.callTeam(tx, conversation, state, await this.passOn(tx, conversation, messages, found), note);
    }
    const order = found.order;
    // O aviso vai para o chat do iFood da loja do pedido, que pode ser outra unidade atendida por este canal: lá ele é
    // gravado numa transação dela, no tom dela.
    const notify = async (store: TenantTx, notice: string) => {
      const chat = await openIfoodConversation(store, order, new Date(), "RESOLVED");
      const messageId = await automationMessage(store, { id: chat.id, tenantId: order.tenantId, channelId: order.channelId }, "courier_arrival", notice);
      return { tenantId: order.tenantId, conversationId: chat.id, messageId };
    };
    const alsoSend =
      order.tenantId === conversation.tenantId
        ? await notify(tx, messages.courierArrivalNotice)
        : await this.db.withTenants({ tenantIds: [order.tenantId] }, async (store) =>
            notify(store, automationMessagesOf(await tenantSettings(store, order.tenantId)).courierArrivalNotice),
          );
    const confirmation = fillMessage(messages.courierArrivalConfirmed, { pedido: found.code });
    const id = await automationMessage(tx, conversation, "courier_arrival_confirmed", confirmation);
    await setAutomationState(tx, conversation.id, { ...state, triage: "done" });
    await tx.conversation.update({ where: { id: conversation.id }, data: { status: "RESOLVED", unreadCount: 0 } });
    return { send: [id], done: false, alsoSend };
  }

  /** "Problema com um pedido": com o pedido achado, o card dele fica na conversa e o entregador conta o que houve. */
  private async findProblemOrder(tx: TenantTx, conversation: Conversation, state: AutomationState, messages: AutomationMessages, text?: string): Promise<Step> {
    const found = await this.findOrder(tx, conversation, text, false);
    if (!found?.order) {
      const note = found ? `Entregador com problema no pedido #${found.code}, que não foi encontrado` : "Entregador com problema em um pedido";
      return this.callTeam(tx, conversation, state, await this.passOn(tx, conversation, messages, found), note);
    }
    // O card traz o botão para a equipe conversar com o cliente do pedido.
    await systemEvent(tx, conversation, { event: "order", orderId: found.order.id, customerChat: true });
    const id = await automationMessage(tx, conversation, "courier_problem_request", fillMessage(messages.courierProblemRequest, { pedido: found.code }));
    await setAutomationState(tx, conversation.id, { ...state, triage: "awaiting_problem" });
    return { send: [id], done: false };
  }

  /**
   * O pedido de hoje ou de ontem com o número que o entregador digitou, aqui ou num restaurante que o canal atende.
   * null = não digitou número; `order: null` = o número não bate com um pedido só (nenhum, ou mais de um).
   */
  private async findOrder(tx: TenantTx, conversation: Conversation, text: string | undefined, ifoodOnly: boolean) {
    const digits = text?.match(/\d+/)?.[0];
    if (!digits) return null;
    const code = digits.replace(/^0+(?=\d)/, "");
    const orders = await withOrderTenants(this.db, tx, conversation.channelId, (scoped) =>
      scoped.order.findMany({
        where: {
          displayCode: { in: [...new Set([digits, code])] },
          placedAt: { gte: startOfYesterday(new Date()) },
          ...(ifoodOnly && { channel: { type: "IFOOD" as const } }),
        },
        select: { id: true, tenantId: true, contactId: true, channelId: true, conversationId: true },
        take: 2,
      }),
    );
    return { code, order: orders.length === 1 ? orders[0]! : null };
  }

  /** Resposta ao entregador quando a equipe assume: o pedido não foi achado, ou não deu para seguir sem ela. */
  private passOn(tx: TenantTx, conversation: Conversation, messages: AutomationMessages, found: { code: string; order: object | null } | null): Promise<string> {
    return found && !found.order
      ? automationMessage(tx, conversation, "order_lookup", fillMessage(messages.courierOrderNotFound, { pedido: found.code }))
      : automationMessage(tx, conversation, "handoff", messages.handoff);
  }

  /** A equipe assume, sem urgência: o painel avisa com o som discreto, não com o alarme. */
  private async callTeam(tx: TenantTx, conversation: Conversation, state: AutomationState, messageId: string, note: string): Promise<Step> {
    await setAutomationState(tx, conversation.id, { ...state, triage: "done" });
    return { send: [messageId], done: false, handoff: true, quiet: true, handoffText: note };
  }
}
