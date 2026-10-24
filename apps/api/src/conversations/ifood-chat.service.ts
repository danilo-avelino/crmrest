import { createHash, randomUUID } from "node:crypto";
import type { TenantTx } from "@dishdesk/database";
import {
  type IfoodChatOutboxItem,
  type IfoodChatSendResult,
  type IfoodChatSync,
  type IfoodChatSyncResult,
  type MessageContent,
} from "@dishdesk/shared";
import { InjectQueue } from "@nestjs/bullmq";
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Queue } from "bullmq";
import type { RequestAuth } from "../auth/auth.decorators.js";
import { INACTIVITY_CLOSE_MS } from "../automations/inactivity.service.js";
import { ENV, type Env } from "../config/env.js";
import { DatabaseService } from "../core/database.service.js";
import { type AutomationJob, QUEUES } from "../queues/queues.module.js";
import { RealtimeEmitter } from "../realtime/realtime.emitter.js";
import { openIfoodConversation } from "./ifood-conversation.js";
import { ifoodWidgetScope } from "./ifood-widget-scope.js";

/**
 * Marca de uma resposta que um painel pegou para digitar no widget. Fica em externalMessageId até a conversa lida do
 * widget mostrar a mensagem, que então ganha a identificação definitiva.
 */
const CLAIM = "ifood-chat-claim:";
/** Uma resposta pega pelo painel só é procurada na conversa lida do widget por este tempo. */
const CLAIM_MATCH_MS = 10 * 60_000;
const HOUR_MS = 60 * 60_000;
/**
 * Mensagem do cliente só aciona as automações (alarme, resposta automática) até esta idade: conversa copiada bem depois,
 * com o painel fechado na hora, entra só como não lida. A folga cobre o fuso do navegador (o widget só mostra a hora).
 */
const ATTEND_WITHIN_MS = 2 * HOUR_MS;
/** Mensagem do cliente até este tempo depois de um balão da loja, na mesma leitura do widget, é resposta à loja. */
const STORE_REPLY_MS = 5 * 60_000;
const BRASILIA_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" });

type ChatOrder = { id: string; tenantId: string; contactId: string; channelId: string; conversationId: string | null; externalOrderId: string; placedAt: Date };
type Entry = { key: string; at: Date; direction: "INBOUND" | "OUTBOUND"; text: string };
/** Conversa que uma leitura mudou e, quando o cliente espera resposta, o que vai para as automações. */
type Synced = { tenantId: string; conversationId: string; ifood?: NonNullable<AutomationJob["ifood"]> };

/**
 * Chat do iFood na Inbox. O iFood não tem API de chat: o painel lê a conversa de cada pedido no widget, pela extensão do
 * Chrome, e manda para cá; as respostas escritas na Inbox ficam pendentes até um painel digitá-las no widget.
 * Tudo depende da trava IFOOD_CHAT_BRIDGE: desligada, as rotas não existem. O widget mostra as lojas de todos os
 * restaurantes do usuário (ifoodWidgetScope), então a ponte também trabalha em todos eles, qualquer que seja o contexto.
 */
@Injectable()
export class IfoodChatService {
  constructor(
    private readonly db: DatabaseService,
    private readonly realtime: RealtimeEmitter,
    @InjectQueue(QUEUES.automations) private readonly automations: Queue<AutomationJob>,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * A conversa de um pedido como o widget mostra agora: grava só as mensagens que ainda não estavam na Inbox.
   * `found: false` = o pedido ainda não chegou pelo polling; o painel manda a conversa de novo mais tarde.
   * Mensagem nova do cliente, ainda sem resposta da loja, vai para as automações (IfoodAttendanceService).
   */
  async sync(auth: RequestAuth, body: IfoodChatSync, now = new Date()): Promise<IfoodChatSyncResult> {
    this.requireEnabled();
    const scope = await ifoodWidgetScope(this.db, auth);
    const changed = await this.db.withTenants(scope, async (tx): Promise<Synced | { conversationId?: undefined } | null> => {
      const order = await tx.order.findFirst({
        where: { displayCode: body.orderCode, channel: { type: "IFOOD" } },
        orderBy: { placedAt: "desc" },
        select: {
          id: true,
          tenantId: true,
          contactId: true,
          channelId: true,
          conversationId: true,
          externalOrderId: true,
          placedAt: true,
          channel: { select: { connectedAt: true } },
        },
      });
      if (!order) return null;
      const entries = transcript(order, body.messages);
      const known = await tx.message.findMany({
        where: { channelId: order.channelId, externalMessageId: { in: entries.map((entry) => entry.key) } },
        select: { externalMessageId: true },
      });
      const fresh = entries.filter((entry) => !known.some((message) => message.externalMessageId === entry.key));
      if (!fresh.length) return {};

      const conversation = await openIfoodConversation(tx, order, fresh[0]!.at);
      // Última vez que cliente e equipe se falaram, antes das mensagens novas (as automáticas do iFood não contam).
      const touch = await tx.message.findFirst({
        where: { conversationId: conversation.id, OR: [{ direction: "INBOUND" }, { direction: "OUTBOUND", sentByUserId: { not: null } }] },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true, sentByUserId: true },
      });
      let unread = 0;
      /** Saídas escritas no próprio widget (as da Inbox, inclusive as automáticas, só são confirmadas). */
      const typed = new Set<Entry>();
      for (const entry of fresh) {
        if (entry.direction === "OUTBOUND" && (await this.confirmSent(tx, conversation.id, entry))) continue;
        if (entry.direction === "OUTBOUND") typed.add(entry);
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
      const result = { tenantId: order.tenantId, conversationId: conversation.id };
      // As automações só entram se a conversa termina numa mensagem recente do cliente (a loja ainda não respondeu),
      // escrita depois de a loja ser conectada: o histórico que o widget mostra ao conectar não recebe resposta automática.
      const newest = fresh.at(-1)!;
      const { connectedAt } = order.channel;
      const waiting =
        newest === entries.at(-1) &&
        newest.direction === "INBOUND" &&
        now.getTime() - newest.at.getTime() <= ATTEND_WITHIN_MS &&
        (!connectedAt || newest.at >= connectedAt);
      if (!waiting) return result;
      const inbound = fresh.filter((entry) => entry.direction === "INBOUND");
      const first = inbound[0]!;
      const recent = !!touch && first.at.getTime() - touch.createdAt.getTime() < INACTIVITY_CLOSE_MS;
      // Cliente respondendo à loja não começa atendimento: a equipe já está na conversa. A loja falou pela Inbox, ou no
      // widget logo antes, na mesma leitura (só o lado do balão não basta: o iFood manda mensagens automáticas desse lado).
      const before = fresh[fresh.indexOf(first) - 1];
      const answering =
        (recent && !!touch?.sentByUserId) || (!!before && typed.has(before) && first.at.getTime() - before.at.getTime() < STORE_REPLY_MS);
      // Como nos outros canais: conversa nova, resolvida ou sem interação há INACTIVITY_CLOSE_MS começa um atendimento.
      const event = {
        channel: { id: order.channelId, tenantId: order.tenantId, type: "IFOOD" as const },
        conversationId: conversation.id,
        previousStatus: conversation.previousStatus,
        newAttendance: !answering && (conversation.previousStatus === null || conversation.previousStatus === "RESOLVED" || !recent),
        text: inbound.map((entry) => entry.text).join("\n"),
      };
      return { ...result, ifood: { event, orderId: order.id } };
    });
    if (changed?.conversationId) {
      this.realtime.inboxChanged(changed.tenantId, changed.conversationId);
      const { tenantId, conversationId, ifood } = changed;
      if (ifood) await this.automations.add("ifood-inbound", { tenantId, conversationId, ifood });
    }
    return { found: changed !== null };
  }

  /** Respostas pendentes das conversas do iFood. Cada uma vai para um painel só, que a digita no chat do pedido. */
  async claim(auth: RequestAuth): Promise<IfoodChatOutboxItem[]> {
    this.requireEnabled();
    const { items, failed } = await this.db.withTenants(await ifoodWidgetScope(this.db, auth), async (tx) => {
      const pending = await tx.message.findMany({
        where: { direction: "OUTBOUND", status: "PENDING", externalMessageId: null, channel: { type: "IFOOD" } },
        orderBy: { createdAt: "asc" },
        take: 10,
        select: { id: true, tenantId: true, conversationId: true, content: true, conversation: { select: { contactId: true, channelId: true } } },
      });
      const items: IfoodChatOutboxItem[] = [];
      const failed: { tenantId: string; conversationId: string }[] = [];
      for (const message of pending) {
        // Resposta ainda em revisão pela IA (atendimento com IA): sai depois, com o texto revisado.
        if ((message.content as MessageContent).aiReview === "pending") continue;
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
    const message = await this.db.withTenants(await ifoodWidgetScope(this.db, auth), async (tx) => {
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
    if (!message) return;
    this.realtime.inboxChanged(message.tenantId, message.conversationId);
    // Como nos outros canais: se o cliente não responder, o atendimento é encerrado (a checagem acontece quando o job roda).
    if (body.status === "SENT") {
      const { tenantId, conversationId } = message;
      await this.automations.add("inactivity", { tenantId, conversationId }, { delay: INACTIVITY_CLOSE_MS });
    }
  }

  private requireEnabled(): void {
    if (!this.env.IFOOD_CHAT_BRIDGE) throw new NotFoundException();
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
