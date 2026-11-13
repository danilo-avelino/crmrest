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

/** O aviso que o entregador manda ao cliente: que chegou, ou que deixou o pedido na portaria. */
type Notice = "arrival" | "front_desk";

/** Opção do menu que pede o número do pedido → a etapa que espera por ele. */
const ORDER_STEP: Partial<Record<string, AutomationState["triage"]>> = {
  "1": "awaiting_arrival_order",
  "2": "awaiting_front_desk_order",
  "3": "awaiting_problem_order",
};

// Número do pedido numa frase do entregador: 2 a 6 dígitos soltos (telefone e valor ficam de fora pelo tamanho ou
// pela vírgula). "089p" (dígito trocado por letra) não conta.
const COURIER_ORDER = /(?<![\d,.])(\d{2,6})(?![\d,.]|\s*(?:min|reais|r\$))/i;
const FRONT_DESK = /portaria|recep[cç][aã]o|deixei|entreguei|seguran[cç]a|guarita|eclusa|vigia|porteiro|balc[aã]o/i;
const ARRIVAL = /cheguei|chegando|t[oô]\s*(?:aqui|aq|na\s+porta|no\s+local|em\s+frente|l[aá])|estou\s+(?:aqui|aq|na\s+porta|no\s+local)|na\s+frente|na\s+porta|aguard|esperando|avis[ae]/i;
const PICKUP = /buscar|pegar|coletar|retirar/i;
const PROBLEM = /m[aá]quina|maquininha|defeito|endere[cç]o\s+errado|cancel|ningu[eé]m|n[aã]o\s+(?:atende|responde|recebe|passa|desce|aceita)/i;

/** O que o entregador pediu numa frase, sem passar pelo menu. */
export type CourierShortcut =
  | { kind: Notice; code: string }
  | { kind: "pickup"; code?: string }
  | { kind: "problem" }
  | { kind: "number"; code: string };

/**
 * Lê o pedido do entregador escrito numa frase ("1024 tá na portaria", "Avisa pro pedido 3289", "6552", "vim buscar"),
 * sem LLM. Portaria vence chegada ("8240 avisa q tá na portaria"); problema vence os dois. null = não deu para entender.
 */
export function courierShortcut(text: string | undefined): CourierShortcut | null {
  if (!text) return null;
  const code = COURIER_ORDER.exec(text)?.[1];
  if (PROBLEM.test(text)) return { kind: "problem" };
  if (PICKUP.test(text)) return code ? { kind: "pickup", code } : { kind: "pickup" };
  if (!code) return null;
  if (FRONT_DESK.test(text)) return { kind: "front_desk", code };
  if (ARRIVAL.test(text)) return { kind: "arrival", code };
  // Só o número (com "pedido", "#" ou pontuação em volta): o menu pergunta o que fazer com ele.
  if (/^\s*(?:o\s+)?(?:pedido\s*)?(?:n[º°]\.?\s*)?#?\s*\d{2,6}\s*[.!?]*\s*$/i.test(text)) return { kind: "number", code };
  return null;
}

/**
 * Menu de quem tem a tag Entregador, no lugar do menu de atendimento (sem aviso de fora do horário nem coleta de telefone):
 * avisar o cliente que chegou ou que deixou o pedido na portaria (pelo chat do iFood do pedido), relatar um problema com
 * um pedido ou falar de outro assunto.
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
    if (event.newAttendance) {
      // Quem já sabe o menu manda a opção ou o aviso inteiro logo na primeira mensagem ("1", "1024 tá na portaria").
      const fresh: AutomationState = { triage: "awaiting_option" };
      return (
        (await this.shortcut(tx, conversation, fresh, messages, event.text)) ??
        (/^\s*[1234]\s*$/.test(event.text ?? "") ? this.chooseOption(tx, conversation, fresh, messages, event.text) : this.sendMenu(tx, conversation, fresh, messages))
      );
    }
    if (state.triage === "awaiting_option") {
      if (/^\s*[1234](?!\d)/.test(event.text ?? "")) return this.chooseOption(tx, conversation, state, messages, event.text);
      return (await this.shortcut(tx, conversation, state, messages, event.text)) ?? this.chooseOption(tx, conversation, state, messages, event.text);
    }
    if (state.triage === "awaiting_arrival_order") return this.notifyCustomer(tx, conversation, state, messages, event.text, "arrival");
    if (state.triage === "awaiting_front_desk_order") return this.notifyCustomer(tx, conversation, state, messages, event.text, "front_desk");
    if (state.triage === "awaiting_problem_order") return this.findProblemOrder(tx, conversation, state, messages, event.text);
    if (state.triage === "awaiting_problem") {
      const id = await automationMessage(tx, conversation, "handoff", messages.courierProblemForwarded);
      await setAutomationState(tx, conversation.id, { ...state, triage: "done" });
      return { send: [id], done: false, handoff: true, handoffText: "Entregador relatou um problema com um pedido" };
    }
    // Atendimento já com a equipe: o aviso completo numa frase ainda vai para o cliente, sem encerrar a conversa
    // ("Cadê o meu robô?", 12/11/2026). O resto é conversa com a equipe.
    if (state.triage === "done") {
      const asked = courierShortcut(event.text);
      if (asked?.kind === "arrival" || asked?.kind === "front_desk") {
        return this.notifyCustomer(tx, conversation, state, messages, asked.code, asked.kind, { keepOpen: true });
      }
    }
    return { send: [], done: false };
  }

  /** O entregador escreveu o pedido numa frase: segue direto, sem o menu. null = a frase não diz o que ele quer. */
  private async shortcut(
    tx: TenantTx,
    conversation: Conversation,
    state: AutomationState,
    messages: AutomationMessages,
    text: string | undefined,
  ): Promise<Step | null> {
    const asked = courierShortcut(text);
    if (!asked) return null;
    if (asked.kind === "arrival" || asked.kind === "front_desk") return this.notifyCustomer(tx, conversation, state, messages, asked.code, asked.kind);
    if (asked.kind === "problem") {
      const id = await automationMessage(tx, conversation, "handoff", messages.courierProblemForwarded);
      await setAutomationState(tx, conversation.id, { ...state, triage: "done" });
      return { send: [id], done: false, handoff: true, handoffText: `Entregador relatou um problema: "${text!.trim().slice(0, 150)}"` };
    }
    if (asked.kind === "pickup") {
      const code = asked.code ?? state.courierOrder;
      const note = code ? `Entregador veio buscar o pedido #${code}` : "Entregador veio buscar um pedido";
      return this.callTeam(tx, conversation, state, await automationMessage(tx, conversation, "handoff", messages.handoff), note);
    }
    // Só o número: o menu pergunta o aviso, e a opção escolhida usa este número. Com o pedido achado, o menu diz isso.
    const next: AutomationState = { ...state, triage: "awaiting_option", courierOrder: asked.code };
    const found = await this.findOrder(tx, conversation, asked.code, false);
    if (found?.order) return this.sendMenu(tx, conversation, next, messages, fillMessage(messages.courierOrderFound, { pedido: found.code }));
    return this.sendMenu(tx, conversation, next, messages);
  }

  private async sendMenu(
    tx: TenantTx,
    conversation: Conversation,
    next: AutomationState,
    messages: AutomationMessages,
    greeting = messages.courierGreeting,
  ): Promise<Step> {
    const text = menuMessage(greeting, firstName(conversation.contact.name), COURIER_MENU_OPTIONS);
    const id = await automationMessage(tx, conversation, "courier_menu", text);
    await setAutomationState(tx, conversation.id, next);
    return { send: [id], done: false };
  }

  private async chooseOption(tx: TenantTx, conversation: Conversation, state: AutomationState, messages: AutomationMessages, text?: string): Promise<Step> {
    const option = /^\s*([1234])(?!\d)/.exec(text ?? "")?.[1];
    // 1, 2 e 3 pedem o número do pedido; 4 (outro assunto) chama a equipe.
    const next = option && ORDER_STEP[option];
    // O número já veio antes da opção: o aviso sai sem perguntar de novo.
    if (state.courierOrder && (option === "1" || option === "2")) {
      return this.notifyCustomer(tx, conversation, state, messages, state.courierOrder, option === "1" ? "arrival" : "front_desk");
    }
    if (state.courierOrder && option === "3") return this.findProblemOrder(tx, conversation, state, messages, state.courierOrder);
    if (next) {
      const id = await automationMessage(tx, conversation, "order_number_request", messages.courierOrderNumberRequest);
      await setAutomationState(tx, conversation.id, { ...state, triage: next });
      return { send: [id], done: false };
    }
    // Resposta fora das opções: o aviso de que não deu para entender e as opções de novo, quantas vezes for preciso.
    // A equipe só é chamada pela opção 4 (ou por um pedido escrito que a automação entenda).
    if (!option) {
      const id = await automationMessage(tx, conversation, "courier_menu", menuMessage(messages.courierNotUnderstood, undefined, COURIER_MENU_OPTIONS));
      return { send: [id], done: false };
    }
    return this.callTeam(tx, conversation, state, await automationMessage(tx, conversation, "handoff", messages.handoff), "Entregador chamando");
  }

  /**
   * "Avisar que cheguei" e "Avisar que deixei na portaria": o aviso vai para o cliente no chat do iFood do pedido e o
   * atendimento do entregador se resolve sozinho. O status do pedido não muda: a entrega vale pelo evento do iFood.
   */
  private async notifyCustomer(
    tx: TenantTx,
    conversation: Conversation,
    state: AutomationState,
    messages: AutomationMessages,
    text: string | undefined,
    kind: Notice,
    { keepOpen = false } = {},
  ): Promise<Step> {
    const found = await this.findOrder(tx, conversation, text, true);
    // Sem o pedido (ou sem o chat do iFood na Inbox), é a equipe que avisa o cliente. O pedido pode ser de outra
    // plataforma (só o iFood recebe o aviso automático); achado, o card dele traz o botão para falar com o cliente.
    // Com a equipe já na conversa, sem o pedido no iFood quem cuida é ela: nada de pedir o número de novo.
    if (keepOpen && (!found?.order || !this.env.IFOOD_CHAT_BRIDGE)) return { send: [], done: false };
    if (!found?.order || !this.env.IFOOD_CHAT_BRIDGE) {
      const known = found && !found.order ? await this.findOrder(tx, conversation, text, false) : found;
      if (known && !known.order && !state.orderRetried) return this.askAgain(tx, conversation, state, messages, known.code);
      if (known?.order) await systemEvent(tx, conversation, { event: "order", orderId: known.order.id, customerChat: true });
      const note =
        kind === "arrival"
          ? known
            ? `Entregador avisou que chegou com o pedido #${known.code}`
            : "Entregador avisou que chegou"
          : known
            ? `Entregador avisou que deixou o pedido #${known.code} na portaria`
            : "Entregador avisou que deixou um pedido na portaria";
      return this.callTeam(tx, conversation, state, await this.passOn(tx, conversation, messages, known), note);
    }
    const noticeOf = (texts: AutomationMessages) => (kind === "arrival" ? texts.courierArrivalNotice : texts.courierFrontDeskNotice);
    const order = found.order;
    // O aviso vai para o chat do iFood da loja do pedido, que pode ser outra unidade atendida por este canal: lá ele é
    // gravado numa transação dela, no tom dela.
    const notify = async (store: TenantTx, notice: string) => {
      const chat = await openIfoodConversation(store, order, new Date(), "RESOLVED");
      const label = kind === "arrival" ? "courier_arrival" : "courier_front_desk";
      const messageId = await automationMessage(store, { id: chat.id, tenantId: order.tenantId, channelId: order.channelId }, label, notice);
      return { tenantId: order.tenantId, conversationId: chat.id, messageId };
    };
    const alsoSend =
      order.tenantId === conversation.tenantId
        ? await notify(tx, noticeOf(messages))
        : await this.db.withTenants({ tenantIds: [order.tenantId] }, async (store) =>
            notify(store, noticeOf(automationMessagesOf(await tenantSettings(store, order.tenantId)))),
          );
    const confirmation = fillMessage(kind === "arrival" ? messages.courierArrivalConfirmed : messages.courierFrontDeskConfirmed, { pedido: found.code });
    const id = await automationMessage(tx, conversation, kind === "arrival" ? "courier_arrival_confirmed" : "courier_front_desk_confirmed", confirmation);
    await setAutomationState(tx, conversation.id, { ...state, triage: "done" });
    if (!keepOpen) await tx.conversation.update({ where: { id: conversation.id }, data: { status: "RESOLVED", unreadCount: 0 } });
    return { send: [id], done: false, alsoSend };
  }

  /** "Problema com um pedido": com o pedido achado, o card dele fica na conversa e o entregador conta o que houve. */
  private async findProblemOrder(tx: TenantTx, conversation: Conversation, state: AutomationState, messages: AutomationMessages, text?: string): Promise<Step> {
    const found = await this.findOrder(tx, conversation, text, false);
    if (found && !found.order && !state.orderRetried) return this.askAgain(tx, conversation, state, messages, found.code);
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

  /** Número que não bate com nenhum pedido (um dígito trocado, por exemplo): o entregador confere e manda de novo, uma vez. */
  private async askAgain(tx: TenantTx, conversation: Conversation, state: AutomationState, messages: AutomationMessages, code: string): Promise<Step> {
    const id = await automationMessage(tx, conversation, "order_lookup", fillMessage(messages.courierOrderRetry, { pedido: code }));
    await setAutomationState(tx, conversation.id, { ...state, orderRetried: true });
    return { send: [id], done: false };
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
