import { createHash, randomUUID } from "node:crypto";
import type { TenantTx } from "@dishdesk/database";
import {
  CHANNEL_LABEL,
  type IfoodChatOutboxItem,
  type IfoodChatSendResult,
  type IfoodChatSync,
  type IfoodChatSyncResult,
  type MessageContent,
} from "@dishdesk/shared";
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { RequestAuth } from "../auth/auth.decorators.js";
import { ENV, type Env } from "../config/env.js";
import { DatabaseService } from "../core/database.service.js";
import { RealtimeEmitter } from "../realtime/realtime.emitter.js";

/**
 * Marca de uma resposta que um painel pegou para digitar no widget. Fica em externalMessageId até a conversa lida do
 * widget mostrar a mensagem, que então ganha a identificação definitiva.
 */
const CLAIM = "ifood-chat-claim:";
/** Uma resposta pega pelo painel só é procurada na conversa lida do widget por este tempo. */
const CLAIM_MATCH_MS = 10 * 60_000;
const HOUR_MS = 60 * 60_000;
const BRASILIA_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" });

type ChatOrder = { id: string; tenantId: string; contactId: string; channelId: string; conversationId: string | null; externalOrderId: string; placedAt: Date };
type Entry = { key: string; at: Date; direction: "INBOUND" | "OUTBOUND"; text: string };

/**
 * Chat do iFood na Inbox. O iFood não tem API de chat: o painel lê a conversa de cada pedido no widget, pela extensão do
 * Chrome, e manda para cá; as respostas escritas na Inbox ficam pendentes até um painel digitá-las no widget.
 * Tudo depende da trava IFOOD_CHAT_BRIDGE: desligada, as rotas não existem.
 */
@Injectable()
export class IfoodChatService {
  constructor(
    private readonly db: DatabaseService,
    private readonly realtime: RealtimeEmitter,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * A conversa de um pedido como o widget mostra agora: grava só as mensagens que ainda não estavam na Inbox.
   * `found: false` = o pedido ainda não chegou pelo polling; o painel manda a conversa de novo mais tarde.
   */
  async sync(auth: RequestAuth, body: IfoodChatSync): Promise<IfoodChatSyncResult> {
    this.requireEnabled();
    const changed = await this.db.withTenants(auth.scope, async (tx) => {
      const order = await tx.order.findFirst({
        where: { displayCode: body.orderCode, channel: { type: "IFOOD" } },
        orderBy: { placedAt: "desc" },
        select: { id: true, tenantId: true, contactId: true, channelId: true, conversationId: true, externalOrderId: true, placedAt: true },
      });
      if (!order) return null;
      const entries = transcript(order, body.messages);
      const known = await tx.message.findMany({
        where: { channelId: order.channelId, externalMessageId: { in: entries.map((entry) => entry.key) } },
        select: { externalMessageId: true },
      });
      const fresh = entries.filter((entry) => !known.some((message) => message.externalMessageId === entry.key));
      if (!fresh.length) return {};

      const conversation = await this.openConversation(tx, order, fresh[0]!.at);
      let unread = 0;
      for (const entry of fresh) {
        if (entry.direction === "OUTBOUND" && (await this.confirmSent(tx, conversation.id, entry))) continue;
        await tx.message.create({
          data: {
            tenantId: order.tenantId,
            conversationId: conversation.id,
            channelId: order.channelId,
            externalMessageId: entry.key,
            direction: entry.direction,
            type: "TEXT",
            content: { text: entry.text } satisfies MessageContent,
            // Saída que não partiu da Inbox: escrita no próprio widget ou mensagem automática do iFood.
            status: entry.direction === "INBOUND" ? "DELIVERED" : "SENT",
            createdAt: entry.at,
          },
        });
        if (entry.direction === "INBOUND") unread += 1;
      }
      const last = fresh.at(-1)!.at;
      await tx.conversation.update({
        where: { id: conversation.id },
        data: {
          ...((!conversation.lastMessageAt || conversation.lastMessageAt < last) && { lastMessageAt: last }),
          ...(unread && { status: "OPEN", unreadCount: { increment: unread } }),
        },
      });
      return { tenantId: order.tenantId, conversationId: conversation.id };
    });
    if (changed?.conversationId) this.realtime.inboxChanged(changed.tenantId, changed.conversationId);
    return { found: changed !== null };
  }

  /** Respostas pendentes das conversas do iFood. Cada uma vai para um painel só, que a digita no chat do pedido. */
  async claim(auth: RequestAuth): Promise<IfoodChatOutboxItem[]> {
    this.requireEnabled();
    const { items, failed } = await this.db.withTenants(auth.scope, async (tx) => {
      const pending = await tx.message.findMany({
        where: { direction: "OUTBOUND", status: "PENDING", externalMessageId: null, channel: { type: "IFOOD" } },
        orderBy: { createdAt: "asc" },
        take: 10,
        select: { id: true, tenantId: true, conversationId: true, content: true, conversation: { select: { contactId: true, channelId: true } } },
      });
      const items: IfoodChatOutboxItem[] = [];
      const failed: { tenantId: string; conversationId: string }[] = [];
      for (const message of pending) {
        // Com dois painéis abertos, só o primeiro leva a mensagem (a condição é reavaliada depois da trava da linha).
        const { count } = await tx.message.updateMany({
          where: { id: message.id, status: "PENDING", externalMessageId: null },
          data: { externalMessageId: `${CLAIM}${randomUUID()}` },
        });
        if (!count) continue;
        // O chat do iFood é por pedido: a resposta vai para o último pedido do cliente na loja.
        const order = await tx.order.findFirst({
          where: { contactId: message.conversation.contactId, channelId: message.conversation.channelId, displayCode: { not: null } },
          orderBy: { placedAt: "desc" },
          select: { displayCode: true },
        });
        if (!order) {
          await tx.message.update({ where: { id: message.id }, data: { status: "FAILED", statusError: "Este cliente não tem pedido do iFood para receber a resposta." } });
          failed.push(message);
          continue;
        }
        items.push({
          messageId: message.id,
          conversationId: message.conversationId,
          orderCode: order.displayCode!,
          text: (message.content as MessageContent).text ?? "",
        });
      }
      return { items, failed };
    });
    for (const message of failed) this.realtime.inboxChanged(message.tenantId, message.conversationId);
    return items;
  }

  /** O painel conta se conseguiu digitar a resposta no widget. */
  async result(auth: RequestAuth, messageId: string, body: IfoodChatSendResult): Promise<void> {
    this.requireEnabled();
    const message = await this.db.withTenants(auth.scope, async (tx) => {
      // Já enviada: a conversa lida do widget confirmou antes. A que falhou por demora ainda pode ter saído.
      const message = await tx.message.findFirst({
        where: { id: messageId, direction: "OUTBOUND", status: { in: ["PENDING", "FAILED"] }, channel: { type: "IFOOD" } },
        select: { id: true, tenantId: true, conversationId: true },
      });
      if (!message) return null;
      await tx.message.update({
        where: { id: message.id },
        data:
          body.status === "SENT"
            ? { status: "SENT", statusError: null }
            : { status: "FAILED", statusError: body.error ?? "O widget do iFood não aceitou a mensagem." },
      });
      return message;
    });
    if (message) this.realtime.inboxChanged(message.tenantId, message.conversationId);
  }

  private requireEnabled(): void {
    if (!this.env.IFOOD_CHAT_BRIDGE) throw new NotFoundException();
  }

  /** Conversa do cliente no canal iFood da loja (a última, ou uma nova), com o pedido na linha do tempo. */
  private async openConversation(tx: TenantTx, order: ChatOrder, at: Date) {
    const where = { contactId: order.contactId, channelId: order.channelId };
    const select = { id: true, lastMessageAt: true };
    const latest = await tx.conversation.findFirst({ where, orderBy: { createdAt: "desc" }, select });
    const conversation = latest ?? (await tx.conversation.create({ data: { tenantId: order.tenantId, ...where, status: "OPEN", createdAt: at }, select }));
    const event = (content: MessageContent, createdAt: Date) =>
      tx.message.create({
        data: { tenantId: order.tenantId, conversationId: conversation.id, channelId: order.channelId, direction: "INTERNAL", type: "SYSTEM", content, createdAt },
      });
    if (!latest) await event({ event: "conversation_opened", text: `Conversa aberta via ${CHANNEL_LABEL.IFOOD}` }, new Date(at.getTime() - 2));
    const shown = await tx.message.findFirst({
      where: { conversationId: conversation.id, content: { path: ["orderId"], equals: order.id } },
      select: { id: true },
    });
    if (!shown) await event({ event: "order", orderId: order.id }, new Date(at.getTime() - 1));
    // Pedido já ligado a outra conversa (o cliente confirmou pelo WhatsApp) continua lá.
    if (!order.conversationId) await tx.order.update({ where: { id: order.id }, data: { conversationId: conversation.id } });
    return conversation;
  }

  /** A mensagem lida é uma resposta que o painel digitou a partir da Inbox? Então já está na conversa: só ganha a identificação. */
  private async confirmSent(tx: TenantTx, conversationId: string, entry: Entry): Promise<boolean> {
    const claimed = await tx.message.findMany({
      where: {
        conversationId,
        direction: "OUTBOUND",
        externalMessageId: { startsWith: CLAIM },
        createdAt: { gte: new Date(entry.at.getTime() - CLAIM_MATCH_MS) },
      },
      orderBy: { createdAt: "asc" },
      select: { id: true, content: true },
    });
    const match = claimed.find((message) => squash((message.content as MessageContent).text ?? "") === squash(entry.text));
    if (!match) return false;
    await tx.message.update({ where: { id: match.id }, data: { externalMessageId: entry.key, status: "SENT", statusError: null } });
    return true;
  }
}

/**
 * Mensagens com data e identificação. O widget só mostra a hora: o dia é o do pedido em Brasília, ou o seguinte se a
 * conversa passou da meia-noite. A identificação vem do que a mensagem mostra (não há id no widget), com um contador
 * para textos iguais no mesmo segundo.
 */
function transcript(order: ChatOrder, messages: IfoodChatSync["messages"]): Entry[] {
  const day = BRASILIA_DAY.format(order.placedAt);
  const repeats = new Map<string, number>();
  return messages.map((message, position) => {
    const clock = message.time.length === 5 ? `${message.time}:00` : message.time;
    const sameDay = new Date(`${day}T${clock}-03:00`).getTime();
    const time = sameDay < order.placedAt.getTime() - HOUR_MS ? sameDay + 24 * HOUR_MS : sameDay;
    const shown = `${message.direction}|${message.time}|${message.text}`;
    const repeat = repeats.get(shown) ?? 0;
    repeats.set(shown, repeat + 1);
    const hash = createHash("sha256").update(`${shown}|${repeat}`).digest("hex").slice(0, 24);
    // A posição desempata mensagens do mesmo segundo, na ordem em que o widget as mostra.
    return { key: `ifood-chat:${order.externalOrderId}:${hash}`, at: new Date(time + position), direction: message.direction, text: message.text };
  });
}

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
