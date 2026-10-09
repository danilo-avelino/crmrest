import type { Prisma } from "@dishdesk/database";
import type { OrderStatus } from "@dishdesk/database/enums";
import { isValidCpf } from "@dishdesk/shared";
import { InjectQueue, Processor } from "@nestjs/bullmq";
import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import type { Queue } from "bullmq";
import { ENV, type Env } from "../config/env.js";
import { IFOOD_STATUS, IfoodClient, type IfoodEvent, type IfoodOrder } from "../connectors/ifood.client.js";
import { DatabaseService } from "../core/database.service.js";
import { type NoticeStatus, OrderNoticeService } from "../orders/order-notice.service.js";
import { JobProcessor } from "../queues/job-processor.js";
import { QUEUES } from "../queues/queues.module.js";
import { RealtimeEmitter } from "../realtime/realtime.emitter.js";
import { InboundService, type ResolvedChannel } from "./inbound.service.js";
import { rememberAddress } from "./orders.js";

/** Pedidos do iFood (E7): o iFood não tem chat por integração, então a conversa mostra os pedidos. */
@Injectable()
export class IfoodService implements OnModuleInit {
  private readonly logger = new Logger(IfoodService.name);
  readonly client: IfoodClient;

  constructor(
    private readonly db: DatabaseService,
    private readonly inbound: InboundService,
    private readonly realtime: RealtimeEmitter,
    private readonly notices: OrderNoticeService,
    @InjectQueue(QUEUES.ifood) private readonly queue: Queue,
    @Inject(ENV) env: Env,
  ) {
    this.client = new IfoodClient(env);
  }

  async onModuleInit(): Promise<void> {
    // Polling a cada 30s, como o iFood recomenda para manter a loja ativa. Idempotente entre réplicas.
    if (this.client.configured) await this.queue.upsertJobScheduler("ifood-polling", { every: 30_000 }, { name: "poll" });
  }

  async poll(): Promise<void> {
    const merchants = await this.db.client.$queryRaw<{ id: string; tenant_id: string; external_id: string }[]>`
      SELECT id, tenant_id, external_id FROM app.ifood_merchants()`;
    // O iFood recusa o polling inteiro se um dos ids não for UUID (ex.: canal de exemplo do seed): esses ficam de fora.
    const invalid = merchants.filter((m) => !MERCHANT_ID.test(m.external_id));
    if (invalid.length) this.logger.warn(`Lojas iFood com id inválido ignoradas: ${invalid.map((m) => m.external_id).join(", ")}`);
    const valid = merchants.filter((m) => MERCHANT_ID.test(m.external_id));
    if (!valid.length) return;
    const channels = new Map(valid.map((m) => [m.external_id, { id: m.id, tenantId: m.tenant_id, type: "IFOOD" as const }]));

    const processed: string[] = [];
    for (const event of await this.client.poll([...channels.keys()])) {
      const channel = channels.get(event.merchantId);
      try {
        if (channel) await this.handle(channel, event);
        processed.push(event.id); // loja desconhecida também é confirmada, para não voltar sempre
      } catch (error) {
        // Sem confirmação o evento volta no próximo polling.
        this.logger.warn(`Evento ${event.id} do iFood não processado: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await this.client.acknowledge(processed);
  }

  /** Todo evento entra na linha do tempo do pedido; os de status também mudam o pedido (e o card na conversa). */
  private async handle(channel: ResolvedChannel, event: IfoodEvent): Promise<void> {
    // Garante o pedido mesmo que o evento PLACED tenha se perdido.
    await this.ensureOrder(channel, event.orderId);
    // O cliente mudou itens depois de confirmar: busca o pedido de novo (itens e total).
    const patched = event.fullCode === "ORDER_PATCHED" && (await this.refreshOrder(channel, event.orderId));

    const status = IFOOD_STATUS[event.fullCode];
    const at = new Date(event.createdAt);
    const updated = await this.db.withTenants({ tenantIds: [channel.tenantId] }, async (tx) => {
      const order = await tx.order.findUniqueOrThrow({
        where: { channelId_externalOrderId: { channelId: channel.id, externalOrderId: event.orderId } },
        select: { id: true, conversationId: true, status: true, dispatchedAt: true },
      });
      const { count } = await tx.orderEvent.createMany({
        data: {
          tenantId: channel.tenantId,
          orderId: order.id,
          externalEventId: event.id,
          code: event.fullCode,
          occurredAt: at,
          ...(event.metadata && { metadata: event.metadata as Prisma.InputJsonObject }),
        },
        skipDuplicates: true,
      });
      // Evento reenviado (já registrado) ou que faria o pedido voltar de etapa: só fica na linha do tempo.
      if (!count || !status || (status !== "CANCELED" && STATUS_RANK[status] <= STATUS_RANK[order.status])) {
        return { conversationId: patched ? order.conversationId : null, notice: null };
      }
      await tx.order.update({
        where: { id: order.id },
        data: {
          status,
          // Saída do restaurante: o primeiro entre "saiu para entrega" (entrega própria) e "coletado" (entregador iFood).
          ...(status === "DISPATCHED" && !order.dispatchedAt && { dispatchedAt: at }),
          // CONCLUDED chega até horas depois da entrega: só DELIVERED marca o horário de entrega.
          ...(event.fullCode === "DELIVERED" && { deliveredAt: at }),
        },
      });
      // Aviso ao cliente: saiu para entrega, ou entregue (só DELIVERED: o CONCLUDED chega horas depois).
      const notice: NoticeStatus | null = status === "DISPATCHED" ? "DISPATCHED" : event.fullCode === "DELIVERED" ? "DELIVERED" : null;
      return { conversationId: order.conversationId, notice: notice && { orderId: order.id, status: notice } };
    });
    if (updated.conversationId) this.realtime.inboxChanged(channel.tenantId, updated.conversationId);
    if (updated.notice) await this.notices.statusChanged(channel.tenantId, updated.notice.orderId, updated.notice.status);
  }

  /** Itens e totais atualizados pelo iFood (ORDER_PATCHED). Devolve true se o pedido existia. */
  private async refreshOrder(channel: ResolvedChannel, orderId: string): Promise<boolean> {
    const order = await this.client.order(orderId);
    return this.db.withTenants({ tenantIds: [channel.tenantId] }, async (tx) => {
      const current = await tx.order.findUnique({
        where: { channelId_externalOrderId: { channelId: channel.id, externalOrderId: orderId } },
        select: { id: true },
      });
      if (!current) return false;
      await tx.orderItem.deleteMany({ where: { orderId: current.id } });
      await tx.order.update({
        where: { id: current.id },
        data: {
          subtotal: order.total.subTotal,
          deliveryFee: order.total.deliveryFee,
          total: order.total.orderAmount,
          raw: order as Prisma.InputJsonObject,
          items: { create: itemsOf(order, channel.tenantId) },
        },
      });
      return true;
    });
  }

  /**
   * Pedido novo: cliente (com CPF da nota e endereço) e pedido, que aparece na aba Pedidos. O iFood não deixa responder
   * pelo Dish Desk, então o pedido não abre conversa; o atendimento acha o pedido pelo cadastro (WhatsApp, Instagram).
   */
  private async ensureOrder(channel: ResolvedChannel, orderId: string): Promise<void> {
    const exists = await this.db.withTenants({ tenantIds: [channel.tenantId] }, (tx) =>
      tx.order.findUnique({ where: { channelId_externalOrderId: { channelId: channel.id, externalOrderId: orderId } }, select: { id: true } }),
    );
    if (exists) return;

    const order = await this.client.order(orderId);
    const at = new Date(order.createdAt);
    const cpf = order.customer.documentNumber?.replace(/\D/g, "");
    const address = order.delivery?.deliveryAddress;

    await this.db.withTenants({ tenantIds: [channel.tenantId] }, async (tx) => {
      const contact = await this.inbound.resolveContact(tx, channel.tenantId, {
        channelType: "IFOOD",
        externalContactId: order.customer.id,
        contactProfile: { name: order.customer.name, ...(cpf && isValidCpf(cpf) && { cpf }) },
        timestamp: at,
      });
      if (address) {
        await rememberAddress(tx, contact, "Entrega iFood", {
          street: address.streetName,
          number: address.streetNumber,
          complement: address.complement,
          district: address.neighborhood,
          city: address.city,
          state: address.state,
          zipCode: address.postalCode,
        });
      }

      await tx.order.create({
        data: {
          tenantId: channel.tenantId,
          contactId: contact.id,
          channelId: channel.id,
          externalOrderId: order.id,
          displayCode: order.displayId ?? null,
          status: "PLACED",
          subtotal: order.total.subTotal,
          deliveryFee: order.total.deliveryFee,
          total: order.total.orderAmount,
          deliveryAddress: address as Prisma.InputJsonObject | undefined,
          placedAt: at,
          raw: order as Prisma.InputJsonObject,
          items: { create: itemsOf(order, channel.tenantId) },
        },
      });
    });
  }
}

const MERCHANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ordem das etapas: um evento atrasado não faz o pedido voltar (o cancelamento vale em qualquer etapa). */
const STATUS_RANK: Record<OrderStatus, number> = {
  PLACED: 0,
  CONFIRMED: 1,
  PREPARING: 2,
  READY: 3,
  DISPATCHED: 4,
  DELIVERED: 5,
  CANCELED: 6,
};

function itemsOf(order: IfoodOrder, tenantId: string) {
  return order.items.map((item) => ({
    tenantId,
    name: item.name,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    notes: item.observations,
  }));
}

@Processor(QUEUES.ifood)
export class IfoodProcessor extends JobProcessor {
  constructor(private readonly ifood: IfoodService) {
    super();
  }

  async process(): Promise<void> {
    await this.ifood.poll();
  }
}
