import type { Prisma } from "@comanda/database";
import { isValidCpf } from "@comanda/shared";
import { InjectQueue, Processor } from "@nestjs/bullmq";
import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import type { Queue } from "bullmq";
import { ENV, type Env } from "../config/env.js";
import { IFOOD_STATUS, IfoodClient, type IfoodEvent } from "../connectors/ifood.client.js";
import { DatabaseService } from "../core/database.service.js";
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
    if (!merchants.length) return;
    const channels = new Map(merchants.map((m) => [m.external_id, { id: m.id, tenantId: m.tenant_id, type: "IFOOD" as const }]));

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

  private async handle(channel: ResolvedChannel, event: IfoodEvent): Promise<void> {
    const status = IFOOD_STATUS[event.fullCode];
    if (!status) return;
    // Garante o pedido mesmo que o evento PLACED tenha se perdido.
    await this.ensureOrder(channel, event.orderId);
    if (status === "PLACED") return;

    const at = new Date(event.createdAt);
    const conversationId = await this.db.withTenants({ tenantIds: [channel.tenantId] }, async (tx) => {
      const order = await tx.order.update({
        where: { channelId_externalOrderId: { channelId: channel.id, externalOrderId: event.orderId } },
        data: {
          status,
          ...(status === "DISPATCHED" && { dispatchedAt: at }),
          ...(status === "DELIVERED" && { deliveredAt: at }),
        },
        select: { conversationId: true },
      });
      return order.conversationId;
    });
    if (conversationId) this.realtime.inboxChanged(channel.tenantId, conversationId);
  }

  /** Pedido novo: cliente (com CPF da nota e endereço), pedido, conversa e o card na linha do tempo. */
  private async ensureOrder(channel: ResolvedChannel, orderId: string): Promise<void> {
    const exists = await this.db.withTenants({ tenantIds: [channel.tenantId] }, (tx) =>
      tx.order.findUnique({ where: { channelId_externalOrderId: { channelId: channel.id, externalOrderId: orderId } }, select: { id: true } }),
    );
    if (exists) return;

    const order = await this.client.order(orderId);
    const at = new Date(order.createdAt);
    const cpf = order.customer.documentNumber?.replace(/\D/g, "");
    const address = order.delivery?.deliveryAddress;

    const conversationId = await this.db.withTenants({ tenantIds: [channel.tenantId] }, async (tx) => {
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

      const conversation = await this.inbound.openConversation(tx, channel, contact.id, at);
      const created = await tx.order.create({
        data: {
          tenantId: channel.tenantId,
          contactId: contact.id,
          channelId: channel.id,
          conversationId: conversation.id,
          externalOrderId: order.id,
          displayCode: order.displayId ?? null,
          status: "PLACED",
          subtotal: order.total.subTotal,
          deliveryFee: order.total.deliveryFee,
          total: order.total.orderAmount,
          deliveryAddress: address as Prisma.InputJsonObject | undefined,
          placedAt: at,
          raw: order as Prisma.InputJsonObject,
          items: {
            create: order.items.map((item) => ({
              tenantId: channel.tenantId,
              name: item.name,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              notes: item.observations,
            })),
          },
        },
        select: { id: true },
      });
      await tx.message.create({
        data: {
          tenantId: channel.tenantId,
          conversationId: conversation.id,
          channelId: channel.id,
          direction: "INTERNAL",
          type: "SYSTEM",
          content: { event: "order", orderId: created.id },
          createdAt: at,
        },
      });
      await tx.conversation.update({
        where: { id: conversation.id },
        data: { status: "OPEN", lastMessageAt: at, unreadCount: { increment: 1 } },
      });
      return conversation.id;
    });
    this.realtime.inboxChanged(channel.tenantId, conversationId);
  }
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
