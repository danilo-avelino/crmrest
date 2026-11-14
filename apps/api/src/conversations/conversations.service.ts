import { parseEncryptionKey, type Prisma, type TenantTx } from "@dishdesk/database";
import type { ChannelType, MessageType } from "@dishdesk/database/enums";
import {
  CHANNEL_CAPABILITIES,
  type ConversationCounts,
  type ConversationDayStats,
  type ConversationListQuery,
  type ConversationMessages,
  type ConversationPage,
  COURIER_TAG,
  type CourierCheckRequest,
  FORWARDABLE_TYPES,
  type MessageContent,
  type MessageDto,
  renderTemplate,
  type SendTemplateRequest,
  type UpdateConversationRequest,
  type WhatsAppTemplate,
  withoutAi,
} from "@dishdesk/shared";
import { InjectQueue } from "@nestjs/bullmq";
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type { Queue } from "bullmq";
import { scheduleEvaluation } from "../ai/ai-evaluation.service.js";
import { LlmClient } from "../ai/llm.client.js";
import type { RequestAuth } from "../auth/auth.decorators.js";
import { AUTOMATIC_ONLY, type AutomationState, channelSends, isPaused, localDate, setAutomationState, systemEvent, teamRepliedUpdate, WITH_TEAM } from "../automations/automation.js";
import { contactsAwaitingDecision } from "../orders/fraud-alert.js";
import { ENV, type Env } from "../config/env.js";
import { ConnectorsService } from "../connectors/connectors.service.js";
import { contactSearch } from "../contacts/contact-search.js";
import { DatabaseService } from "../core/database.service.js";
import { type AiJob, type AutomationJob, type OutboundJob, QUEUES } from "../queues/queues.module.js";
import { withOrderTenants } from "../orders/order-scope.js";
import { RealtimeEmitter } from "../realtime/realtime.emitter.js";
import { isTenantAdmin, memberScope } from "../settings/tenant-admin.js";
import { conversationListInclude, listEvaluations, toListItem, toMessageDto, toOrderDto, withoutRatingScores } from "./conversation.mapper.js";
import { downloadMedia } from "./message-media.js";

const PAGE_SIZE = 50;
const MESSAGES_LIMIT = 200;

/** Conversa aberta pelo alerta de fraude para um pedido sem conversa. */
const TEAM_ONLY_REPLY = "O cliente não está nesta conversa: use uma nota interna.";

@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);
  private readonly key: Buffer;

  constructor(
    private readonly db: DatabaseService,
    private readonly realtime: RealtimeEmitter,
    @InjectQueue(QUEUES.outbound) private readonly outbound: Queue<OutboundJob>,
    @InjectQueue(QUEUES.automations) private readonly automations: Queue<AutomationJob>,
    @InjectQueue(QUEUES.ai) private readonly ai: Queue<AiJob>,
    private readonly connectors: ConnectorsService,
    private readonly llm: LlmClient,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.key = parseEncryptionKey(env.ENCRYPTION_KEY);
  }

  async list(auth: RequestAuth, query: ConversationListQuery): Promise<ConversationPage> {
    // Ativos e Abertos ficam só com as conversas da equipe; as que só tiveram automação vão para a aba Automáticos.
    const byStatus: Record<NonNullable<ConversationListQuery["status"]>, Prisma.ConversationWhereInput> = {
      ACTIVE: { status: { not: "RESOLVED" }, ...WITH_TEAM },
      OPEN: { status: "OPEN", ...WITH_TEAM },
      AUTO: AUTOMATIC_ONLY,
      PENDING: { status: "PENDING" },
      RESOLVED: { status: "RESOLVED" },
    };
    const where: Prisma.ConversationWhereInput = {
      ...(query.status && byStatus[query.status]),
      ...(query.search && { contact: contactSearch(query.search, this.key) }),
    };
    const [rows, awaitingDecision] = await this.db.withTenants(scopeFor(auth, query.tenantId), (tx) =>
      Promise.all([
        tx.conversation.findMany({
          where,
          include: conversationListInclude,
          // Quem está chamando o atendente fica no topo, da espera mais longa para a mais curta.
          orderBy: [{ awaitingAgentSince: { sort: "asc", nulls: "last" } }, { lastMessageAt: { sort: "desc", nulls: "last" } }, { id: "desc" }],
          take: PAGE_SIZE + 1,
          ...(query.cursor && { cursor: { id: query.cursor }, skip: 1 }),
        }),
        contactsAwaitingDecision(tx),
      ]),
    );
    const items = rows.slice(0, PAGE_SIZE).map((row) => toListItem(row, auth, awaitingDecision));
    return { items, nextCursor: rows.length > PAGE_SIZE ? (items.at(-1)?.id ?? null) : null };
  }

  async counts(auth: RequestAuth, tenantId?: string): Promise<ConversationCounts> {
    const calling = { awaitingAgentSince: { not: null }, status: { not: "RESOLVED" } } satisfies Prisma.ConversationWhereInput;
    const [groups, open, awaitingAgent, awaitingQuiet, oldestUrgent, unread] = await this.db.withTenants(scopeFor(auth, tenantId), (tx) =>
      Promise.all([
        tx.conversation.groupBy({ by: ["status"], _count: { _all: true } }),
        tx.conversation.count({ where: { status: "OPEN", ...WITH_TEAM } }),
        tx.conversation.count({ where: calling }),
        tx.conversation.count({ where: { ...calling, awaitingAgentQuiet: true } }),
        tx.conversation.findFirst({
          where: { ...calling, awaitingAgentQuiet: false },
          orderBy: { awaitingAgentSince: "asc" },
          select: { awaitingAgentSince: true },
        }),
        tx.conversation.aggregate({ where: { status: { not: "RESOLVED" } }, _sum: { unreadCount: true } }),
      ]),
    );
    const urgentSince = oldestUrgent?.awaitingAgentSince?.toISOString() ?? null;
    const counts: ConversationCounts = { OPEN: 0, PENDING: 0, RESOLVED: 0, awaitingAgent, awaitingQuiet, urgentSince, unread: unread._sum.unreadCount ?? 0 };
    for (const group of groups) counts[group.status] = group._count._all;
    counts.OPEN = open;
    return counts;
  }

  /**
   * Conversas do dia, desde a meia-noite de Brasília (a RLS limita aos restaurantes do escopo). Equipe = mensagem de uma
   * pessoa (pelo painel ou pelo WhatsApp do celular) ou o atendimento passado para ela, hoje. A conversa só da equipe
   * (alerta de fraude) não entra: o cliente nem está nela. O tempo de resposta e a nota da IA seguem a aba Avaliações.
   */
  async today(auth: RequestAuth, tenantId?: string, now = new Date()): Promise<ConversationDayStats> {
    const from = new Date(`${localDate(now)}T00:00:00-03:00`);
    return this.db.withTenants(scopeFor(auth, tenantId), async (tx) => {
      const [conversations] = await tx.$queryRaw<Pick<ConversationDayStats, "opened" | "resolved" | "resolvedWithoutTeam">[]>`
        SELECT count(*)::int AS opened,
               count(*) FILTER (WHERE c.status = 'RESOLVED')::int AS resolved,
               count(*) FILTER (WHERE c.status = 'RESOLVED' AND NOT EXISTS (
                 SELECT 1 FROM messages m
                 WHERE m.conversation_id = c.id AND m.created_at >= ${from}
                   AND ((m.direction = 'OUTBOUND' AND (m.sent_by_user_id IS NOT NULL OR m.content->>'fromPhone' = 'true'))
                     OR (m.type = 'SYSTEM' AND m.content->>'event' IN ('handoff', 'awaiting_agent')))
               ))::int AS "resolvedWithoutTeam"
        FROM conversations c
        WHERE NOT c.team_only
          AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'INBOUND' AND m.created_at >= ${from})`;
      // Cada passagem à equipe e a primeira resposta de uma pessoa depois dela, antes da próxima passagem.
      const [team] = await tx.$queryRaw<Pick<ConversationDayStats, "calledTeam" | "averageResponseSeconds">[]>`
        SELECT count(DISTINCT h.conversation_id)::int AS "calledTeam",
               avg(EXTRACT(EPOCH FROM r.created_at - h.created_at))::float8 AS "averageResponseSeconds"
        FROM messages h
        LEFT JOIN LATERAL (
          SELECT m.created_at
          FROM messages m
          WHERE m.conversation_id = h.conversation_id
            AND m.direction = 'OUTBOUND' AND m.sent_by_user_id IS NOT NULL AND m.created_at > h.created_at
            AND NOT EXISTS (
              SELECT 1 FROM messages n
              WHERE n.conversation_id = h.conversation_id AND n.type = 'SYSTEM' AND n.content->>'event' = 'handoff'
                AND n.created_at > h.created_at AND n.created_at < m.created_at
            )
          ORDER BY m.created_at
          LIMIT 1
        ) r ON true
        WHERE h.type = 'SYSTEM' AND h.content->>'event' = 'handoff' AND h.created_at >= ${from}`;
      const evaluations = await tx.conversationEvaluation.aggregate({
        where: { legacy: false, createdAt: { gte: from } },
        _count: { _all: true },
        _avg: { score: true },
      });
      return {
        opened: conversations?.opened ?? 0,
        resolved: conversations?.resolved ?? 0,
        resolvedWithoutTeam: conversations?.resolvedWithoutTeam ?? 0,
        calledTeam: team?.calledTeam ?? 0,
        averageResponseSeconds: team?.averageResponseSeconds ?? null,
        evaluations: evaluations._count._all,
        aiScore: evaluations._avg.score,
      };
    });
  }

  async get(auth: RequestAuth, id: string) {
    const [conversation, awaitingDecision] = await this.db.withTenants(auth.scope, (tx) =>
      Promise.all([tx.conversation.findUnique({ where: { id }, include: conversationListInclude }), contactsAwaitingDecision(tx)]),
    );
    if (!conversation) throw new NotFoundException("Conversa não encontrada.");
    return toListItem(conversation, auth, awaitingDecision);
  }

  async messages(auth: RequestAuth, id: string): Promise<ConversationMessages> {
    return this.db.withTenants(auth.scope, async (tx) => {
      const conversation = await this.requireConversation(tx, id);
      const latest = await tx.message.findMany({
        where: { conversationId: id },
        include: { sentByUser: { select: { id: true, name: true } } },
        orderBy: { createdAt: "desc" },
        take: MESSAGES_LIMIT,
      });
      const all = latest.reverse().map(toMessageDto);
      // A nota da pesquisa de satisfação e a avaliação da IA são só do administrador do restaurante.
      const admin = isTenantAdmin(auth, conversation.tenantId);
      const messages = admin ? all : withoutRatingScores(all);
      const evaluations = admin ? await listEvaluations(tx, conversation.tenantId, { conversationId: id }) : [];
      const orderIds = messages.flatMap((m) => (m.content.event === "order" && m.content.orderId ? [m.content.orderId] : []));
      // O card pode ser de um pedido de outro restaurante atendido pelo canal da conversa: ele leva o nome do restaurante.
      const orders = orderIds.length
        ? await withOrderTenants(this.db, tx, conversation.channelId, (scoped) =>
            scoped.order.findMany({
              where: { id: { in: orderIds } },
              include: { items: true, channel: { select: { type: true } }, tenant: { select: { name: true } } },
            }),
          )
        : [];
      const toCard = (order: (typeof orders)[number]) => ({
        ...toOrderDto(order),
        ...(order.tenantId !== conversation.tenantId && { restaurantName: order.tenant.name }),
      });
      return { messages, orders: Object.fromEntries(orders.map((order) => [order.id, toCard(order)])), evaluations };
    });
  }

  /** Arquivo (imagem, áudio...) de uma mensagem recebida, buscado na plataforma (o Dish Desk não guarda mídia). */
  async media(auth: RequestAuth, conversationId: string, messageId: string): Promise<{ body: ReadableStream; mimeType: string }> {
    const message = await this.db.withTenants(auth.scope, (tx) =>
      tx.message.findFirst({
        where: { id: messageId, conversationId },
        select: { content: true, channel: { select: { type: true, credentials: true } } },
      }),
    );
    const media = (message?.content as MessageContent | undefined)?.media;
    if (!message || !media) throw new NotFoundException("Esta mensagem não tem arquivo.");
    // Mídia encaminhada: o arquivo é o da mensagem original.
    if (media.forwardOf) return this.media(auth, await this.conversationOf(auth, media.forwardOf), media.forwardOf);
    try {
      return await downloadMedia(this.connectors, message.channel, media);
    } catch (error) {
      this.logger.warn(`Mídia da mensagem ${messageId} indisponível: ${error instanceof Error ? error.message : String(error)}`);
      throw new NotFoundException("O arquivo não está mais disponível.");
    }
  }

  private async conversationOf(auth: RequestAuth, messageId: string): Promise<string> {
    const message = await this.db.withTenants(auth.scope, (tx) => tx.message.findUnique({ where: { id: messageId }, select: { conversationId: true } }));
    if (!message) throw new NotFoundException("O arquivo não está mais disponível.");
    return message.conversationId;
  }

  /**
   * Encaminha uma mensagem (texto, localização ou arquivo) para outra conversa do mesmo restaurante, como uma resposta da
   * equipe. A localização vai como texto com o link do mapa, que todo canal recebe; o arquivo só vai para o WhatsApp por
   * QR Code, e é buscado na mensagem original na hora do envio (o Dish Desk não guarda mídia).
   */
  async forward(auth: RequestAuth, conversationId: string, messageId: string, targetId: string): Promise<MessageDto> {
    if (conversationId === targetId) throw new BadRequestException("Escolha outra conversa para encaminhar.");
    const message = await this.db.withTenants(auth.scope, async (tx) => {
      const source = await tx.message.findFirst({ where: { id: messageId, conversationId } });
      if (!source) throw new NotFoundException("Mensagem não encontrada.");
      const original = source.content as MessageContent;
      const forwardable = (FORWARDABLE_TYPES as readonly MessageType[]).includes(source.type) && !original.automation;
      if (!forwardable || source.direction === "INTERNAL" || original.aiReview === "blocked") {
        throw new UnprocessableEntityException("Esta mensagem não pode ser encaminhada.");
      }
      const target = await this.requireConversation(tx, targetId);
      if (target.tenantId !== source.tenantId) throw new UnprocessableEntityException("Só dá para encaminhar para uma conversa do mesmo restaurante.");
      if (target.teamOnly) throw new UnprocessableEntityException(TEAM_ONLY_REPLY);
      if (!this.canSend(target.channel.type)) throw new UnprocessableEntityException("Este canal não permite responder pelo Dish Desk.");
      if (CHANNEL_CAPABILITIES[target.channel.type].window24h && (!target.windowExpiresAt || target.windowExpiresAt < new Date())) {
        throw new UnprocessableEntityException("A janela de 24h para resposta livre desta conversa terminou.");
      }

      let type: MessageType = "TEXT";
      let content: MessageContent;
      if (original.location) {
        const { latitude, longitude, name, address } = original.location;
        const place = [name, address].filter(Boolean).join(" · ") || "Localização";
        content = { text: `📍 ${place}\nhttps://www.google.com/maps?q=${latitude},${longitude}`, forwarded: true };
      } else if (original.media) {
        const channel = await tx.channel.findUniqueOrThrow({ where: { id: target.channelId }, select: { credentials: true } });
        if (target.channel.type !== "WHATSAPP" || !this.connectors.secrets(channel.credentials).instance) {
          throw new UnprocessableEntityException("Fotos e arquivos só podem ser encaminhados para conversas do WhatsApp.");
        }
        // Mídia já encaminhada: aponta para a original, que é onde o arquivo está.
        const forwardOf = original.media.forwardOf ?? source.id;
        type = source.type;
        content = {
          ...(original.text && { text: original.text }),
          media: { mimeType: original.media.mimeType, ...(original.media.filename && { filename: original.media.filename }), forwardOf },
          forwarded: true,
        };
      } else if (original.text) content = { text: original.text, forwarded: true };
      else throw new UnprocessableEntityException("Esta mensagem não pode ser encaminhada.");

      const created = await tx.message.create({
        data: {
          tenantId: target.tenantId,
          conversationId: targetId,
          channelId: target.channelId,
          direction: "OUTBOUND",
          type,
          content,
          status: "PENDING",
          sentByUserId: auth.userId,
        },
        include: { sentByUser: { select: { id: true, name: true } } },
      });
      await tx.conversation.update({
        where: { id: targetId },
        data: { lastMessageAt: created.createdAt, ...teamRepliedUpdate(target.status, target.automationState as AutomationState) },
      });
      return created;
    });
    await this.outbound.add("send", { tenantId: message.tenantId, messageId: message.id });
    this.realtime.inboxChanged(message.tenantId, targetId);
    return toMessageDto(message);
  }

  /** Grava a resposta como pendente e enfileira o envio; o status chega depois pelo canal. */
  async sendText(auth: RequestAuth, conversationId: string, text: string): Promise<MessageDto> {
    const message = await this.db.withTenants(auth.scope, async (tx) => {
      const conversation = await this.requireConversation(tx, conversationId);
      const capabilities = CHANNEL_CAPABILITIES[conversation.channel.type];
      if (conversation.teamOnly) throw new UnprocessableEntityException(TEAM_ONLY_REPLY);
      if (!this.canSend(conversation.channel.type)) throw new UnprocessableEntityException("Este canal não permite responder pelo Dish Desk.");
      if (capabilities.window24h && (!conversation.windowExpiresAt || conversation.windowExpiresAt < new Date())) {
        throw new UnprocessableEntityException("A janela de 24h para resposta livre terminou.");
      }
      // Atendimento com IA: a resposta é revisada pela IA no worker, antes do envio (menos para entregador e funcionário
      // e com o Dish Desk pausado).
      const review =
        (await this.llm.activeFor(tx, conversation.tenantId)) &&
        !(await isPaused(tx, conversation.tenantId)) &&
        !withoutAi((await tx.contact.findUniqueOrThrow({ where: { id: conversation.contactId }, select: { tags: true } })).tags);
      const created = await tx.message.create({
        data: {
          tenantId: conversation.tenantId,
          conversationId,
          channelId: conversation.channelId,
          direction: "OUTBOUND",
          type: "TEXT",
          content: { text, ...(review && { aiReview: "pending" }) } satisfies MessageContent,
          status: "PENDING",
          sentByUserId: auth.userId,
        },
        include: { sentByUser: { select: { id: true, name: true } } },
      });
      await tx.conversation.update({
        where: { id: conversationId },
        data: {
          lastMessageAt: created.createdAt,
          ...teamRepliedUpdate(conversation.status, conversation.automationState as AutomationState),
        },
      });
      return created;
    });

    await this.outbound.add("send", { tenantId: message.tenantId, messageId: message.id });
    this.realtime.inboxChanged(message.tenantId, conversationId);
    return toMessageDto(message);
  }

  /** Reenvio de uma mensagem que falhou: volta a pendente e entra de novo na fila, com as mesmas regras do envio. */
  async retryMessage(auth: RequestAuth, conversationId: string, messageId: string): Promise<MessageDto> {
    const message = await this.db.withTenants(auth.scope, async (tx) => {
      const conversation = await this.requireConversation(tx, conversationId);
      const current = await tx.message.findFirst({ where: { id: messageId, conversationId } });
      if (!current) throw new NotFoundException("Mensagem não encontrada.");
      if (current.direction !== "OUTBOUND" || current.status !== "FAILED") {
        throw new UnprocessableEntityException("Só mensagens que falharam podem ser reenviadas.");
      }
      const capabilities = CHANNEL_CAPABILITIES[conversation.channel.type];
      if (!this.canSend(conversation.channel.type)) throw new UnprocessableEntityException("Este canal não permite responder pelo Dish Desk.");
      // Template pode sair com a janela fechada; texto livre, não (§5.5).
      const windowClosed = !conversation.windowExpiresAt || conversation.windowExpiresAt < new Date();
      if (capabilities.window24h && windowClosed && !(current.content as MessageContent).template) {
        throw new UnprocessableEntityException("A janela de 24h para resposta livre terminou.");
      }
      return tx.message.update({
        where: { id: messageId },
        // No chat do iFood, a marca do painel que pegou a mensagem sai junto: outro painel pode pegar o reenvio.
        data: { status: "PENDING", statusError: null, ...(conversation.channel.type === "IFOOD" && { externalMessageId: null }) },
        include: { sentByUser: { select: { id: true, name: true } } },
      });
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
      if (conversation.teamOnly) throw new UnprocessableEntityException(TEAM_ONLY_REPLY);
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
      await tx.conversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: created.createdAt, unreadCount: 0, awaitingAgentSince: null, teamInvolved: true },
      });
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
      // A equipe está cuidando da conversa: ela vai para a aba Ativos.
      if (conversation.status !== "RESOLVED") await tx.conversation.update({ where: { id: conversationId }, data: { teamInvolved: true } });
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
    const { conversation, resolved } = await this.db.withTenants(auth.scope, async (tx) => {
      const current = await this.requireConversation(tx, conversationId);
      if (body.assignedUserId) {
        // Só pode receber a conversa quem é membro ativo do restaurante dela.
        const member = await tx.tenantMember.findUnique({
          where: { tenantId_userId: { tenantId: current.tenantId, userId: body.assignedUserId } },
          select: { isActive: true },
        });
        if (!member?.isActive) throw new BadRequestException("Esta pessoa não atende neste restaurante.");
      }
      const updated = await tx.conversation.update({
        where: { id: conversationId },
        data: {
          ...(body.status && { status: body.status }),
          ...(body.status === "RESOLVED" && { awaitingAgentSince: null }), // resolvida sem resposta: o alarme para
          ...(body.assignedUserId !== undefined && { assignedUserId: body.assignedUserId }),
          // Resolvida: o próximo atendimento começa sem a equipe. Reaberta, deixada pendente ou atribuída: é da equipe.
          ...(body.status === "RESOLVED"
            ? { teamInvolved: false }
            : (body.status || body.assignedUserId) && { teamInvolved: true }),
        },
        include: conversationListInclude,
      });
      return { conversation: updated, resolved: body.status === "RESOLVED" && current.status !== "RESOLVED" };
    });
    // Fim do atendimento: a pesquisa de satisfação decide no worker se pergunta a nota; a IA avalia o atendimento.
    // A conversa só da equipe não teve atendimento: o cliente nem está nela.
    if (resolved && !conversation.teamOnly) {
      await this.automations.add("survey", { tenantId: conversation.tenantId, conversationId });
      await scheduleEvaluation(this.ai, conversation.tenantId, conversationId);
    }
    this.realtime.inboxChanged(conversation.tenantId, conversationId);
    return toListItem(conversation, auth);
  }

  /**
   * Resposta da equipe ao modal "Esta pessoa é um entregador?" (a IA desconfiou na conversa): sim põe a tag Entregador no
   * cadastro (o próximo atendimento já abre no menu do entregador); não só fecha a pergunta. Nos dois casos a IA não
   * pergunta de novo neste atendimento.
   */
  async courierCheck(auth: RequestAuth, conversationId: string, body: CourierCheckRequest) {
    const conversation = await this.db.withTenants(auth.scope, async (tx) => {
      const current = await this.requireConversation(tx, conversationId);
      const state = current.automationState as AutomationState;
      const { courierCheck: _, ...rest } = state;
      await setAutomationState(tx, conversationId, { ...rest, courierChecked: true });
      const contact = await tx.contact.findUniqueOrThrow({ where: { id: current.contactId }, select: { tags: true } });
      if (body.courier && !contact.tags.includes(COURIER_TAG)) {
        await tx.contact.update({ where: { id: current.contactId }, data: { tags: [COURIER_TAG, ...contact.tags] } });
      }
      await systemEvent(tx, current, {
        event: "courier_check",
        text: body.courier ? "A equipe confirmou que é um entregador: o cadastro ganhou a tag Entregador" : "A equipe disse que não é um entregador",
      });
      return tx.conversation.findUniqueOrThrow({ where: { id: conversationId }, include: conversationListInclude });
    });
    this.realtime.inboxChanged(conversation.tenantId, conversationId);
    return toListItem(conversation, auth);
  }

  /** O canal aceita resposta pela Inbox? */
  private canSend(type: ChannelType): boolean {
    return channelSends(type, this.env);
  }

  private async requireConversation(tx: TenantTx, id: string) {
    const conversation = await tx.conversation.findUnique({ where: { id }, include: { channel: { select: { type: true } } } });
    if (!conversation) throw new NotFoundException("Conversa não encontrada.");
    return conversation;
  }

}

/** No painel master, a lista pode ser filtrada por um dos restaurantes do usuário. */
export function scopeFor(auth: RequestAuth, tenantId?: string) {
  if (!tenantId) return auth.scope;
  return memberScope(auth, tenantId);
}
