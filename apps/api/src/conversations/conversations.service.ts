import { blindIndex, parseEncryptionKey, type Prisma, type TenantTx } from "@comanda/database";
import {
  CHANNEL_CAPABILITIES,
  type ConversationCounts,
  type ConversationListQuery,
  type ConversationMessages,
  type ConversationPage,
  type MessageContent,
  type MessageDto,
  renderTemplate,
  type SendTemplateRequest,
  type UpdateConversationRequest,
  type WhatsAppTemplate,
} from "@comanda/shared";
import { InjectQueue } from "@nestjs/bullmq";
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type { Queue } from "bullmq";
import type { RequestAuth } from "../auth/auth.decorators.js";
import { ENV, type Env } from "../config/env.js";
import { ConnectorsService } from "../connectors/connectors.service.js";
import { DatabaseService } from "../core/database.service.js";
import { type OutboundJob, QUEUES } from "../queues/queues.module.js";
import { RealtimeEmitter } from "../realtime/realtime.emitter.js";
import { conversationListInclude, toListItem, toMessageDto, toOrderDto } from "./conversation.mapper.js";

const PAGE_SIZE = 50;
const MESSAGES_LIMIT = 200;

@Injectable()
export class ConversationsService {
  private readonly key: Buffer;

  constructor(
    private readonly db: DatabaseService,
    private readonly realtime: RealtimeEmitter,
    @InjectQueue(QUEUES.outbound) private readonly outbound: Queue<OutboundJob>,
    private readonly connectors: ConnectorsService,
    @Inject(ENV) env: Env,
  ) {
    this.key = parseEncryptionKey(env.ENCRYPTION_KEY);
  }

  async list(auth: RequestAuth, query: ConversationListQuery): Promise<ConversationPage> {
    const where: Prisma.ConversationWhereInput = {
      ...(query.status && { status: query.status }),
      ...(query.search && { contact: this.contactSearch(query.search) }),
    };
    const rows = await this.db.withTenants(scopeFor(auth, query.tenantId), (tx) =>
      tx.conversation.findMany({
        where,
        include: conversationListInclude,
        orderBy: [{ lastMessageAt: { sort: "desc", nulls: "last" } }, { id: "desc" }],
        take: PAGE_SIZE + 1,
        ...(query.cursor && { cursor: { id: query.cursor }, skip: 1 }),
      }),
    );
    const items = rows.slice(0, PAGE_SIZE).map(toListItem);
    return { items, nextCursor: rows.length > PAGE_SIZE ? (items.at(-1)?.id ?? null) : null };
  }

  async counts(auth: RequestAuth, tenantId?: string): Promise<ConversationCounts> {
    const groups = await this.db.withTenants(scopeFor(auth, tenantId), (tx) =>
      tx.conversation.groupBy({ by: ["status"], _count: { _all: true } }),
    );
    const counts: ConversationCounts = { OPEN: 0, PENDING: 0, RESOLVED: 0 };
    for (const group of groups) counts[group.status] = group._count._all;
    return counts;
  }

  async get(auth: RequestAuth, id: string) {
    const conversation = await this.db.withTenants(auth.scope, (tx) =>
      tx.conversation.findUnique({ where: { id }, include: conversationListInclude }),
    );
    if (!conversation) throw new NotFoundException("Conversa não encontrada.");
    return toListItem(conversation);
  }

  async messages(auth: RequestAuth, id: string): Promise<ConversationMessages> {
    return this.db.withTenants(auth.scope, async (tx) => {
      await this.requireConversation(tx, id);
      const latest = await tx.message.findMany({
        where: { conversationId: id },
        include: { sentByUser: { select: { id: true, name: true } } },
        orderBy: { createdAt: "desc" },
        take: MESSAGES_LIMIT,
      });
      const messages = latest.reverse().map(toMessageDto);
      const orderIds = messages.flatMap((m) => (m.content.event === "order" && m.content.orderId ? [m.content.orderId] : []));
      const orders = orderIds.length
        ? await tx.order.findMany({ where: { id: { in: orderIds } }, include: { items: true } })
        : [];
      return { messages, orders: Object.fromEntries(orders.map((order) => [order.id, toOrderDto(order)])) };
    });
  }

  /** Grava a resposta como pendente e enfileira o envio; o status chega depois pelo canal. */
  async sendText(auth: RequestAuth, conversationId: string, text: string): Promise<MessageDto> {
    const message = await this.db.withTenants(auth.scope, async (tx) => {
      const conversation = await this.requireConversation(tx, conversationId);
      const capabilities = CHANNEL_CAPABILITIES[conversation.channel.type];
      if (!capabilities.send) throw new UnprocessableEntityException("Este canal não permite responder pelo Comanda.");
      if (capabilities.window24h && (!conversation.windowExpiresAt || conversation.windowExpiresAt < new Date())) {
        throw new UnprocessableEntityException("A janela de 24h para resposta livre terminou.");
      }
      const created = await tx.message.create({
        data: {
          tenantId: conversation.tenantId,
          conversationId,
          channelId: conversation.channelId,
          direction: "OUTBOUND",
          type: "TEXT",
          content: { text } satisfies MessageContent,
          status: "PENDING",
          sentByUserId: auth.userId,
        },
        include: { sentByUser: { select: { id: true, name: true } } },
      });
      // Responder implica ter lido a conversa.
      await tx.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: created.createdAt, unreadCount: 0 } });
      return created;
    });

    await this.outbound.add("send", { tenantId: message.tenantId, messageId: message.id });
    this.realtime.inboxChanged(message.tenantId, conversationId);
    return toMessageDto(message);
  }

  /** Templates aprovados do WhatsApp do canal da conversa. */
  async templates(auth: RequestAuth, conversationId: string): Promise<WhatsAppTemplate[]> {
    const channel = await this.db.withTenants(auth.scope, async (tx) => {
      await this.requireConversation(tx, conversationId);
      return (await tx.conversation.findUniqueOrThrow({ where: { id: conversationId }, select: { channel: true } })).channel;
    });
    if (channel.type !== "WHATSAPP") throw new UnprocessableEntityException("Templates só existem no WhatsApp.");
    const secrets = this.connectors.secrets(channel.credentials);
    try {
      return await this.connectors.whatsapp.listTemplates(secrets.wabaId, secrets.accessToken);
    } catch (error) {
      throw new UnprocessableEntityException(error instanceof Error ? error.message : "Templates indisponíveis.");
    }
  }

  /** Template aprovado: o único envio permitido com a janela de 24h fechada (§5.5). */
  async sendTemplate(auth: RequestAuth, conversationId: string, request: SendTemplateRequest): Promise<MessageDto> {
    const template = (await this.templates(auth, conversationId)).find(
      (t) => t.name === request.name && t.language === request.language,
    );
    if (!template) throw new UnprocessableEntityException("Template não encontrado ou não aprovado.");
    if (request.variables.length !== template.variables) {
      throw new BadRequestException(`Este template precisa de ${template.variables} variável(is).`);
    }

    const message = await this.db.withTenants(auth.scope, async (tx) => {
      const conversation = await this.requireConversation(tx, conversationId);
      const created = await tx.message.create({
        data: {
          tenantId: conversation.tenantId,
          conversationId,
          channelId: conversation.channelId,
          direction: "OUTBOUND",
          type: "TEXT",
          content: {
            text: renderTemplate(template.body, request.variables),
            template: { name: template.name, language: template.language, variables: request.variables },
          } satisfies MessageContent,
          status: "PENDING",
          sentByUserId: auth.userId,
        },
        include: { sentByUser: { select: { id: true, name: true } } },
      });
      await tx.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: created.createdAt, unreadCount: 0 } });
      return created;
    });
    await this.outbound.add("send", { tenantId: message.tenantId, messageId: message.id });
    this.realtime.inboxChanged(message.tenantId, conversationId);
    return toMessageDto(message);
  }

  /** Nota interna (§5.1): fica na conversa, nunca vai para o cliente. */
  async addNote(auth: RequestAuth, conversationId: string, text: string): Promise<MessageDto> {
    const note = await this.db.withTenants(auth.scope, async (tx) => {
      const conversation = await this.requireConversation(tx, conversationId);
      return tx.message.create({
        data: {
          tenantId: conversation.tenantId,
          conversationId,
          channelId: conversation.channelId,
          direction: "INTERNAL",
          type: "NOTE",
          content: { text } satisfies MessageContent,
          sentByUserId: auth.userId,
        },
        include: { sentByUser: { select: { id: true, name: true } } },
      });
    });
    this.realtime.inboxChanged(note.tenantId, conversationId);
    return toMessageDto(note);
  }

  async markRead(auth: RequestAuth, conversationId: string): Promise<void> {
    const tenantId = await this.db.withTenants(auth.scope, async (tx) => {
      const conversation = await this.requireConversation(tx, conversationId);
      if (conversation.unreadCount === 0) return null;
      await tx.conversation.update({ where: { id: conversationId }, data: { unreadCount: 0 } });
      return conversation.tenantId;
    });
    if (tenantId) this.realtime.inboxChanged(tenantId, conversationId);
  }

  async update(auth: RequestAuth, conversationId: string, body: UpdateConversationRequest) {
    const conversation = await this.db.withTenants(auth.scope, async (tx) => {
      const current = await this.requireConversation(tx, conversationId);
      if (body.assignedUserId) {
        // Só pode receber a conversa quem é membro ativo do restaurante dela.
        const member = await tx.tenantMember.findUnique({
          where: { tenantId_userId: { tenantId: current.tenantId, userId: body.assignedUserId } },
          select: { isActive: true },
        });
        if (!member?.isActive) throw new BadRequestException("Esta pessoa não atende neste restaurante.");
      }
      return tx.conversation.update({
        where: { id: conversationId },
        data: {
          ...(body.status && { status: body.status }),
          ...(body.assignedUserId !== undefined && { assignedUserId: body.assignedUserId }),
        },
        include: conversationListInclude,
      });
    });
    this.realtime.inboxChanged(conversation.tenantId, conversationId);
    return toListItem(conversation);
  }

  private async requireConversation(tx: TenantTx, id: string) {
    const conversation = await tx.conversation.findUnique({ where: { id }, include: { channel: { select: { type: true } } } });
    if (!conversation) throw new NotFoundException("Conversa não encontrada.");
    return conversation;
  }

  /** Busca por nome, telefone ou CPF (pelo hash; o CPF nunca é comparado em claro). */
  private contactSearch(search: string): Prisma.ContactWhereInput {
    const digits = search.replace(/\D/g, "");
    return {
      OR: [
        { name: { contains: search, mode: "insensitive" } },
        ...(digits.length >= 4 ? [{ phone: { contains: digits } }] : []),
        ...(digits.length === 11 ? [{ cpfHash: blindIndex(digits, this.key) }] : []),
      ],
    };
  }
}

/** No painel master, a lista pode ser filtrada por um dos restaurantes do usuário. */
export function scopeFor(auth: RequestAuth, tenantId?: string) {
  if (!tenantId) return auth.scope;
  if (!auth.scope.tenantIds.includes(tenantId)) throw new ForbiddenException("Sem acesso a este restaurante.");
  return { tenantIds: [tenantId], userId: auth.userId };
}
