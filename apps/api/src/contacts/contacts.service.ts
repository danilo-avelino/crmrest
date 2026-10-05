import { blindIndex, decrypt, encrypt, parseEncryptionKey, Prisma, type TenantTx } from "@comanda/database";
import {
  CHANNEL_LABEL,
  CONTACT_PAGE_SIZE,
  type ContactDetail,
  type ContactFilterOptions,
  type ContactListQuery,
  type ContactPage,
  type ConversationListItem,
  type DuplicatePair,
  type DuplicateSide,
  maskCpf,
  type MessageContent,
  type OrderDto,
  type UpdateContactRequest,
} from "@comanda/shared";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { RequestAuth } from "../auth/auth.decorators.js";
import { ENV, type Env } from "../config/env.js";
import { conversationListInclude, toListItem, toOrderDto } from "../conversations/conversation.mapper.js";
import { DatabaseService } from "../core/database.service.js";
import { RealtimeEmitter } from "../realtime/realtime.emitter.js";
import { findDuplicatePairs } from "./contact-duplicates.js";
import { mergeContacts } from "./contact-merge.js";
import { contactSearch } from "./contact-search.js";

const DAY = 24 * 60 * 60_000;
const ORDERS_LIMIT = 100;
// O que identifica o cliente nas mensagens some na anonimização; o registro da conversa fica.
const REMOVED: MessageContent = { text: "Conteúdo removido (LGPD)" };

@Injectable()
export class ContactsService {
  private readonly key: Buffer;

  constructor(
    private readonly db: DatabaseService,
    private readonly realtime: RealtimeEmitter,
    @Inject(ENV) env: Env,
  ) {
    this.key = parseEncryptionKey(env.ENCRYPTION_KEY);
  }

  /** Lista de clientes com busca, filtros e ordenação (board Clientes). */
  async list(auth: RequestAuth, query: ContactListQuery): Promise<ContactPage> {
    const filtered = Boolean(query.tag?.length || query.channel?.length || query.district || query.phonePending || query.lastContact);
    const where: Prisma.ContactWhereInput = {
      ...(query.search && contactSearch(query.search, this.key)),
      // Anonimizados não têm dados para casar com os filtros.
      ...(filtered && { deletedAt: null }),
      ...(query.tag?.length && { tags: { hasSome: query.tag } }),
      ...(query.channel?.length && { identities: { some: { channelType: { in: query.channel } } } }),
      ...(query.district && { addresses: { some: { district: { equals: query.district, mode: "insensitive" } } } }),
      ...(query.phonePending && { phone: null }),
      ...(query.lastContact && { AND: [lastContactWhere(query.lastContact)] }),
    };
    const sort = { sort: query.order, nulls: "last" } as const;
    const orderBy: Prisma.ContactOrderByWithRelationInput[] = [
      query.sort === "name"
        ? { name: sort }
        : query.sort === "phone"
          ? { phone: sort }
          : query.sort === "orders"
            ? { orders: { _count: query.order } }
            : { lastSeenAt: sort },
      { id: "desc" },
    ];

    return this.db.withTenants(auth.scope, async (tx) => {
      const total = await tx.contact.count({ where });
      const rows = await tx.contact.findMany({
        where,
        orderBy,
        skip: (query.page - 1) * CONTACT_PAGE_SIZE,
        take: CONTACT_PAGE_SIZE,
        select: {
          id: true,
          name: true,
          tags: true,
          phone: true,
          phoneStatus: true,
          firstSeenAt: true,
          lastSeenAt: true,
          deletedAt: true,
          tenant: { select: { id: true, name: true } },
          identities: { select: { channelType: true } },
          // Bairro do endereço principal: o primeiro cadastrado que tem bairro.
          addresses: { where: { district: { not: null } }, orderBy: { id: "asc" }, take: 1, select: { district: true } },
        },
      });
      const totals = await tx.order.groupBy({
        by: ["contactId"],
        where: { contactId: { in: rows.map((row) => row.id) } },
        _count: { _all: true },
        _sum: { total: true },
      });
      const byContact = new Map(totals.map((group) => [group.contactId, group]));

      return {
        total,
        page: query.page,
        pageSize: CONTACT_PAGE_SIZE,
        items: rows.map((row) => ({
          id: row.id,
          tenant: row.tenant,
          name: row.name,
          tags: row.tags,
          phone: row.phone,
          phoneStatus: row.phoneStatus,
          channels: [...new Set(row.identities.map((identity) => identity.channelType))],
          district: row.addresses[0]?.district ?? null,
          ordersCount: byContact.get(row.id)?._count._all ?? 0,
          ordersTotal: (byContact.get(row.id)?._sum.total ?? 0).toString(),
          firstSeenAt: row.firstSeenAt.toISOString(),
          lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
          anonymizedAt: row.deletedAt?.toISOString() ?? null,
        })),
      };
    });
  }

  /** Opções dos filtros Tag e Bairro. */
  filterOptions(auth: RequestAuth): Promise<ContactFilterOptions> {
    return this.db.withTenants(auth.scope, async (tx) => {
      const tags = await tx.$queryRaw<{ tag: string }[]>`
        SELECT DISTINCT unnest(tags) AS tag FROM contacts WHERE deleted_at IS NULL ORDER BY 1`;
      const districts = await tx.contactAddress.findMany({
        where: { district: { not: null } },
        distinct: ["district"],
        orderBy: { district: "asc" },
        select: { district: true },
      });
      return { tags: tags.map((row) => row.tag), districts: districts.map((row) => row.district!) };
    });
  }

  get(auth: RequestAuth, id: string): Promise<ContactDetail> {
    return this.db.withTenants(auth.scope, (tx) => this.load(tx, id));
  }

  /** Aba Conversas: todas as conversas do cliente, em todos os canais. */
  conversations(auth: RequestAuth, id: string): Promise<ConversationListItem[]> {
    return this.db.withTenants(auth.scope, async (tx) => {
      await this.requireContact(tx, id);
      const rows = await tx.conversation.findMany({
        where: { contactId: id },
        include: conversationListInclude,
        orderBy: [{ lastMessageAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      });
      return rows.map(toListItem);
    });
  }

  /** Aba Pedidos: os mais recentes primeiro, com os itens. */
  orders(auth: RequestAuth, id: string): Promise<OrderDto[]> {
    return this.db.withTenants(auth.scope, async (tx) => {
      await this.requireContact(tx, id);
      const rows = await tx.order.findMany({
        where: { contactId: id },
        include: { items: true, channel: { select: { type: true } } },
        orderBy: { placedAt: "desc" },
        take: ORDERS_LIMIT,
      });
      return rows.map(toOrderDto);
    });
  }

  /** Edição pelo atendente: os dados digitados passam a valer sobre os automáticos (§5.2). */
  async update(auth: RequestAuth, id: string, body: UpdateContactRequest): Promise<ContactDetail> {
    const { detail, conversationIds } = await this.db.withTenants(auth.scope, async (tx) => {
      if ((await this.load(tx, id)).anonymized) throw new ConflictException("Este cliente foi anonimizado.");
      const data: Prisma.ContactUpdateInput = {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.email !== undefined && { email: body.email }),
        ...(body.notes !== undefined && { notes: body.notes }),
        ...(body.tags !== undefined && { tags: [...new Set(body.tags)] }),
        ...(body.phone !== undefined &&
          (body.phone
            ? { phone: body.phone, phoneSource: "agent", phoneStatus: "ok" }
            : { phone: null, phoneSource: null, phoneStatus: "pending" })),
        ...(body.cpf !== undefined &&
          (body.cpf
            ? { cpfEncrypted: encrypt(body.cpf, this.key), cpfHash: blindIndex(body.cpf, this.key) }
            : { cpfEncrypted: null, cpfHash: null })),
      };
      await tx.contact.update({ where: { id }, data });
      const conversations = await tx.conversation.findMany({ where: { contactId: id }, select: { id: true, tenantId: true } });
      return { detail: await this.load(tx, id), conversationIds: conversations };
    });
    for (const conversation of conversationIds) this.realtime.inboxChanged(conversation.tenantId, conversation.id);
    return detail;
  }

  /** CPF completo só sob demanda, com registro em auditoria (§8). */
  async revealCpf(auth: RequestAuth, id: string): Promise<{ cpf: string | null }> {
    return this.db.withTenants(auth.scope, async (tx) => {
      const contact = await tx.contact.findUnique({ where: { id }, select: { tenantId: true, cpfEncrypted: true } });
      if (!contact) throw new NotFoundException("Cliente não encontrado.");
      if (!contact.cpfEncrypted) return { cpf: null };
      await tx.auditLog.create({
        data: { tenantId: contact.tenantId, userId: auth.userId, action: "contact.cpf_viewed", entity: "contact", entityId: id },
      });
      return { cpf: decrypt(contact.cpfEncrypted, this.key) };
    });
  }

  /** Fila de possíveis duplicados, só dos restaurantes em que o usuário é admin. */
  async duplicates(auth: RequestAuth): Promise<DuplicatePair[]> {
    const tenantIds = auth.tenants.filter((tenant) => tenant.role === "ADMIN").map((tenant) => tenant.id);
    if (tenantIds.length === 0) throw new ForbiddenException("Só administradores do restaurante revisam duplicados.");

    return this.db.withTenants({ tenantIds, userId: auth.userId }, async (tx) => {
      const pairs = await findDuplicatePairs(tx);
      const contacts = await tx.contact.findMany({
        where: { id: { in: [...new Set(pairs.flatMap((pair) => [pair.a, pair.b]))] } },
        include: {
          identities: { select: { channelType: true } },
          addresses: { select: { street: true, number: true } },
          _count: { select: { orders: true, conversations: true } },
        },
      });
      const sides = new Map(
        contacts.map((contact): [string, DuplicateSide] => [
          contact.id,
          {
            id: contact.id,
            name: contact.name,
            phone: contact.phone,
            tags: contact.tags,
            channels: [...new Set(contact.identities.map((identity) => identity.channelType))],
            // Mesma chave que a união usa para não repetir endereços.
            addressKeys: contact.addresses.map((address) => `${address.street}|${address.number ?? ""}`),
            ordersCount: contact._count.orders,
            conversationsCount: contact._count.conversations,
            firstSeenAt: contact.firstSeenAt.toISOString(),
          },
        ]),
      );
      return pairs.map((pair) => {
        const [a, b] = [sides.get(pair.a)!, sides.get(pair.b)!];
        // Como na união: fica o mais antigo (no empate, o primeiro).
        const [keep, other] = a.firstSeenAt <= b.firstSeenAt ? [a, b] : [b, a];
        return { tenantId: pair.tenantId, reasons: pair.reasons, keep, other };
      });
    });
  }

  /** União manual (admin): fica o cadastro mais antigo; o outro é removido (§5.2). */
  async merge(auth: RequestAuth, [first, second]: [string, string]): Promise<{ contactId: string }> {
    const { contactId, tenantId, conversationIds } = await this.db.withTenants(auth.scope, async (tx) => {
      const [a, b] = await this.requirePair(tx, auth, first, second);
      const result = await mergeContacts(tx, a, b, auth.userId);
      if (!result.merged) {
        throw new ConflictException(
          result.conflict === "telefone" ? "Estes cadastros têm telefones diferentes." : "Estes cadastros têm CPFs diferentes.",
        );
      }
      const conversations = await tx.conversation.findMany({ where: { contactId: result.contactId }, select: { id: true } });
      return { contactId: result.contactId, tenantId: a.tenantId, conversationIds: conversations.map((c) => c.id) };
    });
    for (const conversationId of conversationIds) this.realtime.inboxChanged(tenantId, conversationId);
    return { contactId };
  }

  /** "Não são a mesma pessoa": o par sai da fila de duplicados. */
  async dismissDuplicate(auth: RequestAuth, [first, second]: [string, string]): Promise<void> {
    await this.db.withTenants(auth.scope, async (tx) => {
      const [a] = await this.requirePair(tx, auth, first, second);
      const [contactAId, contactBId] = [first, second].sort() as [string, string];
      await tx.contactDuplicateDismissal.upsert({
        where: { contactAId_contactBId: { contactAId, contactBId } },
        create: { tenantId: a.tenantId, contactAId, contactBId },
        update: {},
      });
    });
  }

  /** Direito de acesso do titular (LGPD): tudo o que o restaurante guarda sobre o cliente. Fica na auditoria. */
  async exportData(auth: RequestAuth, id: string) {
    return this.db.withTenants(auth.scope, async (tx) => {
      const contact = await tx.contact.findUnique({ where: { id }, include: { identities: true, addresses: true, consents: true } });
      if (!contact) throw new NotFoundException("Cliente não encontrado.");
      requireAdmin(auth, contact.tenantId);
      const conversations = await tx.conversation.findMany({
        where: { contactId: id },
        orderBy: { createdAt: "asc" },
        include: {
          channel: { select: { type: true } },
          // As notas internas são da equipe; vai a conversa com o cliente.
          messages: { where: { direction: { not: "INTERNAL" } }, orderBy: { createdAt: "asc" } },
        },
      });
      const orders = await tx.order.findMany({ where: { contactId: id }, orderBy: { placedAt: "asc" }, include: { items: true, channel: { select: { type: true } } } });
      await tx.auditLog.create({
        data: { tenantId: contact.tenantId, userId: auth.userId, action: "contact.exported", entity: "contact", entityId: id },
      });

      return {
        geradoEm: new Date().toISOString(),
        cadastro: {
          nome: contact.name,
          telefone: contact.phone,
          email: contact.email,
          cpf: contact.cpfEncrypted ? decrypt(contact.cpfEncrypted, this.key) : null,
          dataDeNascimento: contact.birthDate?.toISOString().slice(0, 10) ?? null,
          observacoes: contact.notes,
          tags: contact.tags,
          primeiroContato: contact.firstSeenAt.toISOString(),
          ultimoContato: contact.lastSeenAt?.toISOString() ?? null,
        },
        canais: contact.identities.map((identity) => ({
          canal: CHANNEL_LABEL[identity.channelType],
          identificador: identity.externalId,
          perfil: identity.profile,
        })),
        enderecos: contact.addresses.map(({ id: _id, tenantId: _t, contactId: _c, ...address }) => address),
        consentimentos: contact.consents.map((consent) => ({
          finalidade: consent.purpose,
          concedido: consent.granted,
          origem: consent.source,
          data: consent.createdAt.toISOString(),
        })),
        conversas: conversations.map((conversation) => ({
          canal: CHANNEL_LABEL[conversation.channel.type],
          iniciadaEm: conversation.createdAt.toISOString(),
          mensagens: conversation.messages.map((message) => ({
            de: message.direction === "INBOUND" ? "cliente" : "restaurante",
            tipo: message.type,
            conteudo: message.content,
            data: message.createdAt.toISOString(),
          })),
        })),
        pedidos: orders.map((order) => ({ ...toOrderDto(order), enderecoDeEntrega: order.deliveryAddress })),
      };
    });
  }

  /**
   * Anonimização (LGPD): apaga os dados pessoais e os canais vinculados. Pedidos e conversas ficam para os relatórios,
   * sem o que identifica o cliente (endereço do pedido, payload da origem e o texto das mensagens).
   */
  async anonymize(auth: RequestAuth, id: string): Promise<ContactDetail> {
    const { detail, tenantId, conversationIds } = await this.db.withTenants(auth.scope, async (tx) => {
      const contact = await tx.contact.findUnique({ where: { id }, select: { tenantId: true, deletedAt: true } });
      if (!contact) throw new NotFoundException("Cliente não encontrado.");
      requireAdmin(auth, contact.tenantId);
      if (contact.deletedAt) throw new ConflictException("Este cliente já foi anonimizado.");

      await tx.contact.update({
        where: { id },
        data: {
          name: null,
          phone: null,
          phoneSource: null,
          phoneStatus: null,
          email: null,
          cpfEncrypted: null,
          cpfHash: null,
          birthDate: null,
          notes: null,
          tags: [],
          deletedAt: new Date(),
        },
      });
      await tx.contactIdentity.deleteMany({ where: { contactId: id } });
      await tx.contactAddress.deleteMany({ where: { contactId: id } });
      await tx.consent.deleteMany({ where: { contactId: id } });
      await tx.order.updateMany({ where: { contactId: id }, data: { deliveryAddress: Prisma.DbNull, raw: {} } });
      await tx.orderItem.updateMany({ where: { order: { contactId: id } }, data: { notes: null } });

      const conversations = await tx.conversation.findMany({ where: { contactId: id }, select: { id: true } });
      const conversationIds = conversations.map((conversation) => conversation.id);
      // Mídia vira texto: a referência ao arquivo também identifica. Nota continua nota; eventos do sistema não têm dados do cliente.
      await tx.message.updateMany({
        where: { conversationId: { in: conversationIds }, type: { notIn: ["SYSTEM", "NOTE"] } },
        data: { type: "TEXT", content: REMOVED },
      });
      await tx.message.updateMany({ where: { conversationId: { in: conversationIds }, type: "NOTE" }, data: { content: REMOVED } });

      await tx.auditLog.create({
        data: { tenantId: contact.tenantId, userId: auth.userId, action: "contact.anonymized", entity: "contact", entityId: id },
      });
      return { detail: await this.load(tx, id), tenantId: contact.tenantId, conversationIds };
    });
    for (const conversationId of conversationIds) this.realtime.inboxChanged(tenantId, conversationId);
    return detail;
  }

  private async requireContact(tx: TenantTx, id: string) {
    const contact = await tx.contact.findUnique({ where: { id }, select: { id: true } });
    if (!contact) throw new NotFoundException("Cliente não encontrado.");
    return contact;
  }

  /** Dois cadastros ativos do mesmo restaurante, e o usuário é admin dele. */
  private async requirePair(tx: TenantTx, auth: RequestAuth, first: string, second: string) {
    if (first === second) throw new BadRequestException("Escolha dois cadastros diferentes.");
    const contacts = await tx.contact.findMany({ where: { id: { in: [first, second] }, deletedAt: null } });
    const a = contacts.find((contact) => contact.id === first);
    const b = contacts.find((contact) => contact.id === second);
    if (!a || !b) throw new NotFoundException("Cliente não encontrado.");
    if (a.tenantId !== b.tenantId) throw new BadRequestException("Os cadastros são de restaurantes diferentes.");
    requireAdmin(auth, a.tenantId);
    return [a, b] as const;
  }

  private async load(tx: TenantTx, id: string): Promise<ContactDetail> {
    const contact = await tx.contact.findUnique({ where: { id }, include: { identities: true, addresses: true } });
    if (!contact) throw new NotFoundException("Cliente não encontrado.");
    const orders = await tx.order.aggregate({ where: { contactId: id }, _count: { _all: true }, _sum: { total: true } });
    const recent = await tx.order.findMany({ where: { contactId: id }, orderBy: { placedAt: "desc" }, take: 3 });
    const conversationsCount = await tx.conversation.count({ where: { contactId: id } });
    const latest = await tx.conversation.findFirst({
      where: { contactId: id },
      orderBy: [{ lastMessageAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      select: { id: true },
    });
    const anonymizedBy = contact.deletedAt
      ? await tx.auditLog.findFirst({
          where: { action: "contact.anonymized", entity: "contact", entityId: id },
          orderBy: { createdAt: "desc" },
          select: { user: { select: { name: true } } },
        })
      : null;

    return {
      id: contact.id,
      tenantId: contact.tenantId,
      name: contact.name,
      phone: contact.phone,
      phoneSource: contact.phoneSource,
      phoneStatus: contact.phoneStatus,
      email: contact.email,
      cpfMasked: contact.cpfEncrypted ? maskCpf(decrypt(contact.cpfEncrypted, this.key)) : null,
      notes: contact.notes,
      tags: contact.tags,
      firstSeenAt: contact.firstSeenAt.toISOString(),
      identities: contact.identities.map((identity) => ({
        channelType: identity.channelType,
        externalId: identity.externalId,
        username: (identity.profile as { username?: string } | null)?.username ?? null,
      })),
      addresses: contact.addresses.map(({ tenantId: _t, contactId: _c, ...address }) => address),
      metrics: { ordersCount: orders._count._all, ordersTotal: (orders._sum.total ?? 0).toString() },
      recentOrders: recent.map((order) => ({
        id: order.id,
        displayCode: order.displayCode,
        status: order.status,
        total: order.total.toFixed(2),
        placedAt: order.placedAt.toISOString(),
      })),
      lastSeenAt: contact.lastSeenAt?.toISOString() ?? null,
      conversationsCount,
      latestConversationId: latest?.id ?? null,
      anonymized: contact.deletedAt
        ? { at: contact.deletedAt.toISOString(), by: anonymizedBy?.user?.name ?? null }
        : null,
    };
  }
}

/** Ações sobre dados do cliente que só o admin do restaurante faz (unir, exportar, anonimizar). */
function requireAdmin(auth: RequestAuth, tenantId: string): void {
  if (auth.tenants.find((tenant) => tenant.id === tenantId)?.role !== "ADMIN") {
    throw new ForbiddenException("Só administradores do restaurante podem fazer isso.");
  }
}

function lastContactWhere(filter: NonNullable<ContactListQuery["lastContact"]>): Prisma.ContactWhereInput {
  const days = { "7d": 7, "30d": 30, over30d: 30, over60d: 60, over90d: 90 }[filter];
  const since = new Date(Date.now() - days * DAY);
  if (!filter.startsWith("over")) return { lastSeenAt: { gte: since } };
  return { OR: [{ lastSeenAt: { lt: since } }, { lastSeenAt: null }] };
}
