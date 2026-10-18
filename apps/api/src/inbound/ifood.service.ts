import type { Prisma } from "@dishdesk/database";
import type { OrderStatus } from "@dishdesk/database/enums";
import { isValidCpf } from "@dishdesk/shared";
import { InjectQueue, Processor } from "@nestjs/bullmq";
import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import type { Queue } from "bullmq";
import { IfoodAuthService } from "../connectors/ifood-auth.service.js";
import { IFOOD_STATUS, type IfoodClient, IfoodError, type IfoodEvent, type IfoodOrder } from "../connectors/ifood.client.js";
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
    private readonly auth: IfoodAuthService,
    @InjectQueue(QUEUES.ifood) private readonly queue: Queue,
  ) {
    this.client = auth.platform;
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

    if (!this.auth.distributed) {
      await this.process(this.client, channels, await this.pollEvents(channels));
      return;
    }
    // Distribuído: cada loja tem o próprio acesso, então a consulta é loja a loja.
    for (const [merchantId, channel] of channels) {
      const client = this.auth.clientFor(channel);
      try {
        await this.process(client, channels, await client.poll([merchantId]));
      } catch (error) {
        // 401/403: a loja revogou o acesso (ou ele não renova mais). Outros erros: tenta de novo no próximo polling.
        if (error instanceof IfoodError && (error.status === 401 || error.status === 403)) await this.refuse(channel);
        else this.logger.warn(`Polling da loja iFood do canal ${channel.id} falhou: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Trata os eventos e confirma ao iFood os processados (com a mesma credencial que os buscou). */
  private async process(client: IfoodClient, channels: Map<string, ResolvedChannel>, events: IfoodEvent[]): Promise<void> {
    const processed: string[] = [];
    for (const event of events) {
      const channel = channels.get(event.merchantId);
      try {
        if (channel) await this.handle(client, channel, event);
        processed.push(event.id); // loja desconhecida também é confirmada, para não voltar sempre
      } catch (error) {
        // Sem confirmação o evento volta no próximo polling.
        this.logger.warn(`Evento ${event.id} do iFood não processado: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await client.acknowledge(processed);
  }

  /** A loja não autoriza mais o aplicativo: fica "Com erro" e sai do polling até o restaurante conectar de novo. */
  private async refuse(channel: ResolvedChannel): Promise<void> {
    this.logger.warn(`Loja iFood do canal ${channel.id} não autoriza mais o aplicativo: marcada com erro.`);
    await this.db.withTenants({ tenantIds: [channel.tenantId] }, (tx) =>
      tx.channel.update({ where: { id: channel.id }, data: { status: "ERROR" } }),
    );
    this.auth.forget(channel.id);
  }

  /**
   * Eventos de todas as lojas numa consulta só. O iFood recusa a consulta inteira (403) se uma das lojas não autoriza
   * mais o aplicativo: nesse caso, depois de tentar com um token novo, consulta loja a loja; a recusada fica "Com erro"
   * (sai do polling até o restaurante conectar de novo) e as outras seguem. Se todas forem recusadas, o problema é da
   * credencial: ninguém é marcado.
   */
  private async pollEvents(channels: Map<string, ResolvedChannel>): Promise<IfoodEvent[]> {
    try {
      return await this.client.poll([...channels.keys()]);
    } catch (error) {
      if (!(error instanceof IfoodError) || error.status !== 403) throw error;
    }
    // O token pode ser anterior à aprovação de uma loja recém-conectada: antes de culpar a loja, tenta com um novo.
    if (this.client.forgetToken()) {
      try {
        return await this.client.poll([...channels.keys()]);
      } catch (error) {
        if (!(error instanceof IfoodError) || error.status !== 403) throw error;
      }
    }
    const events: IfoodEvent[] = [];
    const refused: ResolvedChannel[] = [];
    for (const [merchantId, channel] of channels) {
      try {
        events.push(...(await this.client.poll([merchantId])));
      } catch (error) {
        if (!(error instanceof IfoodError) || error.status !== 403) throw error;
        refused.push(channel);
      }
    }
    if (refused.length === channels.size) {
      this.logger.error("O iFood recusou (403) o polling de todas as lojas: conferir a credencial do aplicativo.");
      return [];
    }
    for (const channel of refused) await this.refuse(channel);
    return events;
  }

  /** Todo evento entra na linha do tempo do pedido; os de status também mudam o pedido (e o card na conversa). */
  private async handle(client: IfoodClient, channel: ResolvedChannel, event: IfoodEvent): Promise<void> {
    // Garante o pedido mesmo que o evento PLACED tenha se perdido.
    await this.ensureOrder(client, channel, event.orderId);
    // O cliente mudou itens depois de confirmar: busca o pedido de novo (itens e total).
    const patched = event.fullCode === "ORDER_PATCHED" && (await this.refreshOrder(client, channel, event.orderId));

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
      // Aviso ao cliente: ficou pronto, saiu para entrega, ou entregue (só DELIVERED: o CONCLUDED chega horas depois).
      const notice: NoticeStatus | null =
        status === "READY" || status === "DISPATCHED" ? status : event.fullCode === "DELIVERED" ? "DELIVERED" : null;
      return { conversationId: order.conversationId, notice: notice && { orderId: order.id, status: notice } };
    });
    if (updated.conversationId) this.realtime.inboxChanged(channel.tenantId, updated.conversationId);
    if (updated.notice) await this.notices.statusChanged(channel.tenantId, updated.notice.orderId, updated.notice.status);
  }

  /** Itens e totais atualizados pelo iFood (ORDER_PATCHED). Devolve true se o pedido existia. */
  private async refreshOrder(client: IfoodClient, channel: ResolvedChannel, orderId: string): Promise<boolean> {
    const order = await client.order(orderId);
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
  private async ensureOrder(client: IfoodClient, channel: ResolvedChannel, orderId: string): Promise<void> {
    const exists = await this.db.withTenants({ tenantIds: [channel.tenantId] }, (tx) =>
      tx.order.findUnique({ where: { channelId_externalOrderId: { channelId: channel.id, externalOrderId: orderId } }, select: { id: true } }),
    );
    if (exists) return;

    const order = await client.order(orderId);
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
    // O preço da linha inclui os complementos; sem ele (pedido antigo, payload incompleto) vale o preço base.
    unitPrice: item.totalPrice != null && item.quantity > 0 ? Math.round((item.totalPrice / item.quantity) * 100) / 100 : item.unitPrice,
    notes: item.observations,
    // Complementos na ordem do pedido; a personalização de um complemento vem logo abaixo dele.
    options: (item.options ?? []).flatMap((option) => [
      `${option.quantity}× ${option.name}`,
      ...(option.customizations ?? []).map((custom) => `↳ ${custom.quantity}× ${custom.name}`),
    ]),
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
