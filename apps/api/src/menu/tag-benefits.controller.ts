import type { Prisma } from "@dishdesk/database";
import { automationMessagesOf, fillMessage, RECOVERY_TAGS, tagBenefitsOf, TagBenefitsSettings } from "@dishdesk/shared";
import { InjectQueue } from "@nestjs/bullmq";
import { Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, Put } from "@nestjs/common";
import type { Queue } from "bullmq";
import { CurrentAuth, type RequestAuth } from "../auth/auth.decorators.js";
import { automationMessage, dispatch } from "../automations/automation.js";
import { ZodPipe } from "../common/zod.pipe.js";
import { DatabaseService } from "../core/database.service.js";
import { type OutboundJob, QUEUES } from "../queues/queues.module.js";
import { RealtimeEmitter } from "../realtime/realtime.emitter.js";
import { adminScope } from "../settings/tenant-admin.js";
import { requireModule } from "./menu.service.js";
import { formatCents } from "./pricing.js";

const WINDOW_MS = 24 * 60 * 60_000;

export type RecoveryContactDto = {
  contactId: string;
  name: string | null;
  phone: string | null;
  tags: string[];
  conversationId: string | null;
  windowOpen: boolean;
  lastOfferAt: string | null;
};

/** "R$ 15,00 de desconto e entrega grátis". */
export function giftText(recovery: { discountCents: number; freeDelivery: boolean }): string {
  const parts = [recovery.discountCents > 0 ? `${formatCents(recovery.discountCents)} de desconto` : null, recovery.freeDelivery ? "entrega grátis" : null].filter(Boolean);
  return parts.join(" e ");
}

/**
 * Configurações → Vantagens por tag (22/11/2026): cupom e frete grátis de cada tag positiva e a recuperação das tags
 * negativas (presente silencioso no checkout e a mensagem no WhatsApp, só dentro da janela de 24 h).
 */
@Controller("menu/:tenantId/tag-benefits")
export class TagBenefitsController {
  constructor(
    private readonly db: DatabaseService,
    private readonly realtime: RealtimeEmitter,
    @InjectQueue(QUEUES.outbound) private readonly outbound: Queue<OutboundJob>,
  ) {}

  @Get()
  get(@Param("tenantId", ParseUUIDPipe) tenantId: string, @CurrentAuth() auth: RequestAuth) {
    return this.db.withTenants(adminScope(auth, tenantId), async (tx) => {
      await requireModule(tx, tenantId);
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settings: true } });
      return tagBenefitsOf(tenant.settings);
    });
  }

  @Put()
  save(@Param("tenantId", ParseUUIDPipe) tenantId: string, @Body(new ZodPipe(TagBenefitsSettings)) body: TagBenefitsSettings, @CurrentAuth() auth: RequestAuth) {
    return this.db.withTenants(adminScope(auth, tenantId), async (tx) => {
      await requireModule(tx, tenantId);
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settings: true } });
      const settings = { ...((tenant.settings ?? {}) as Prisma.JsonObject), tagBenefits: body };
      await tx.tenant.update({ where: { id: tenantId }, data: { settings } });
      return body;
    });
  }

  /** Clientes com tag negativa (Insatisfeito, Em recuperação), com a conversa do WhatsApp e a janela de 24 h. */
  @Get("recovery-contacts")
  recoveryContacts(@Param("tenantId", ParseUUIDPipe) tenantId: string, @CurrentAuth() auth: RequestAuth): Promise<RecoveryContactDto[]> {
    return this.db.withTenants(adminScope(auth, tenantId), async (tx) => {
      await requireModule(tx, tenantId);
      const contacts = await tx.contact.findMany({
        where: { tenantId, deletedAt: null, tags: { hasSome: [...RECOVERY_TAGS] } },
        orderBy: { lastSeenAt: { sort: "desc", nulls: "last" } },
        take: 200,
        select: { id: true, name: true, phone: true, tags: true },
      });
      if (!contacts.length) return [];
      const conversations = await tx.conversation.findMany({
        where: { tenantId, contactId: { in: contacts.map((c) => c.id) }, channel: { type: "WHATSAPP" } },
        orderBy: { createdAt: "desc" },
        select: { id: true, contactId: true },
      });
      const conversationOf = new Map<string, string>();
      for (const c of conversations) if (!conversationOf.has(c.contactId)) conversationOf.set(c.contactId, c.id);
      const ids = [...conversationOf.values()];
      const [inbound, offers] = await Promise.all([
        tx.message.groupBy({ by: ["conversationId"], where: { tenantId, conversationId: { in: ids }, direction: "INBOUND" }, _max: { createdAt: true } }),
        tx.message.groupBy({ by: ["conversationId"], where: { tenantId, conversationId: { in: ids }, content: { path: ["automation"], equals: "menu_recovery_offer" } }, _max: { createdAt: true } }),
      ]);
      const lastIn = new Map(inbound.map((r) => [r.conversationId, r._max.createdAt]));
      const lastOffer = new Map(offers.map((r) => [r.conversationId, r._max.createdAt]));
      const now = Date.now();
      return contacts.map((contact) => {
        const conversationId = conversationOf.get(contact.id) ?? null;
        const last = conversationId ? lastIn.get(conversationId) : null;
        const offer = conversationId ? lastOffer.get(conversationId) : null;
        return {
          contactId: contact.id,
          name: contact.name,
          phone: contact.phone,
          tags: contact.tags.filter((tag) => (RECOVERY_TAGS as readonly string[]).includes(tag)),
          conversationId,
          windowOpen: Boolean(last && now - last.getTime() < WINDOW_MS),
          lastOfferAt: offer?.toISOString() ?? null,
        };
      });
    });
  }

  /** Mensagem de recuperação no tom da loja, oferecendo o presente sem dizer o motivo. Uma por cliente a cada 30 dias. */
  @Post("recovery-contacts/:contactId/message")
  @HttpCode(200)
  async sendOffer(@Param("tenantId", ParseUUIDPipe) tenantId: string, @Param("contactId", ParseUUIDPipe) contactId: string, @CurrentAuth() auth: RequestAuth) {
    const contacts = await this.recoveryContacts(tenantId, auth);
    const target = contacts.find((c) => c.contactId === contactId);
    if (!target?.conversationId) throw new NotFoundException("Cliente sem conversa no WhatsApp ou fora da recuperação.");
    if (!target.windowOpen) throw new ConflictException("Passou a janela de 24 h do WhatsApp: a mensagem só sai depois que o cliente escrever.");
    if (target.lastOfferAt && Date.now() - Date.parse(target.lastOfferAt) < 30 * 24 * 60 * 60_000) throw new ConflictException("Este cliente já recebeu a oferta de recuperação nos últimos 30 dias.");
    const sent = await this.db.withTenants(adminScope(auth, tenantId), async (tx) => {
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { settings: true } });
      const recovery = tagBenefitsOf(tenant.settings).recovery;
      if (!recovery.enabled || !recovery.sendMessage) throw new ConflictException("Ligue a recuperação e a mensagem em Vantagens por tag.");
      const conversation = await tx.conversation.findFirstOrThrow({ where: { id: target.conversationId!, tenantId }, select: { id: true, tenantId: true, channelId: true } });
      const text = fillMessage(automationMessagesOf(tenant.settings).menuRecoveryOffer, { nome: target.name?.trim().split(/\s+/)[0] ?? "", presente: giftText(recovery) });
      const messageId = await automationMessage(tx, conversation, "menu_recovery_offer", text);
      return { conversationId: conversation.id, messageId };
    });
    await dispatch(this.outbound, this.realtime, tenantId, sent.conversationId, [sent.messageId]);
    return { ok: true };
  }
}
