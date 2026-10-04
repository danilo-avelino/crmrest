import { blindIndex, decrypt, encrypt, parseEncryptionKey, type Prisma, type TenantTx } from "@comanda/database";
import { type ContactDetail, maskCpf, type UpdateContactRequest } from "@comanda/shared";
import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { RequestAuth } from "../auth/auth.decorators.js";
import { ENV, type Env } from "../config/env.js";
import { DatabaseService } from "../core/database.service.js";
import { RealtimeEmitter } from "../realtime/realtime.emitter.js";

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

  get(auth: RequestAuth, id: string): Promise<ContactDetail> {
    return this.db.withTenants(auth.scope, (tx) => this.load(tx, id));
  }

  /** Edição pelo atendente: os dados digitados passam a valer sobre os automáticos (§5.2). */
  async update(auth: RequestAuth, id: string, body: UpdateContactRequest): Promise<ContactDetail> {
    const { detail, conversationIds } = await this.db.withTenants(auth.scope, async (tx) => {
      await this.load(tx, id);
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

  private async load(tx: TenantTx, id: string): Promise<ContactDetail> {
    const contact = await tx.contact.findUnique({ where: { id }, include: { identities: true, addresses: true } });
    if (!contact) throw new NotFoundException("Cliente não encontrado.");
    const orders = await tx.order.aggregate({ where: { contactId: id }, _count: { _all: true }, _sum: { total: true } });
    const recent = await tx.order.findMany({ where: { contactId: id }, orderBy: { placedAt: "desc" }, take: 3 });

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
    };
  }
}
