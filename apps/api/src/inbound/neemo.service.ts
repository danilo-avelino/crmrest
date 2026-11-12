import type { Prisma, TenantTx } from "@dishdesk/database";
import type { OrderStatus } from "@dishdesk/database/enums";
import { isValidCpf, type OrderHistoryImport, toE164 } from "@dishdesk/shared";
import { InjectQueue, Processor } from "@nestjs/bullmq";
import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import * as Sentry from "@sentry/nestjs";
import type { Job, Queue } from "bullmq";
import { ENV, type Env } from "../config/env.js";
import {
  NEEMO_CUSTOMERS_PAGE,
  NEEMO_ORDERS_PAGE,
  NEEMO_TAKEOUT,
  NeemoClient,
  type NeemoCustomer,
  type NeemoOrder,
  neemoStage,
} from "../connectors/neemo.client.js";
import { ConnectorsService } from "../connectors/connectors.service.js";
import { refreshContactTags } from "../contacts/contact-tags.service.js";
import { DatabaseService } from "../core/database.service.js";
import { FraudService } from "../orders/fraud.service.js";
import { OrderNoticeService } from "../orders/order-notice.service.js";
import { JobProcessor } from "../queues/job-processor.js";
import { type NeemoHistoryJob, type NeemoImportJob, QUEUES } from "../queues/queues.module.js";
import { InboundService, type ResolvedChannel } from "./inbound.service.js";
import { rememberAddress } from "./orders.js";

/** Primeira leitura (ou depois de reiniciar): os pedidos alterados nas últimas 24 h. */
const MAX_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** Cada polling relê um pouco antes de onde parou: a leitura é idempotente e tolera relógios desencontrados. */
const OVERLAP_MS = 60_000;
/** O manual da Neemo pede cerca de 60 s entre as consultas de pedidos. */
const POLL_EVERY_MS = 60_000;
/** A API não publica limite de requisições: um intervalo folgado entre as páginas. */
const CUSTOMERS_PAGE_INTERVAL_MS = 1_000;
const HISTORY_PAGE_INTERVAL_MS = 500;
/** O histórico deixa de fora as últimas 24 h, que o polling lê com os itens e acompanha o status. */
const HISTORY_RECENT_MS = 24 * 60 * 60 * 1000;
/**
 * Clientes gravados por transação. A página da API tem 500, e gravar todos numa transação só passa dos 5 s que o Prisma
 * dá a cada uma (no banco de produção, a cada consulta soma a ida e volta pela rede).
 */
const CUSTOMERS_PER_TRANSACTION = 50;

/**
 * Pedidos da Neemo (Linx Delivery App, cardápio digital do restaurante). Como no Cardápio Web, eles trazem o telefone,
 * então entram no cadastro do cliente (o mesmo do WhatsApp) sem abrir conversa: o atendimento continua no WhatsApp.
 */
@Injectable()
export class NeemoService implements OnModuleInit {
  private readonly logger = new Logger(NeemoService.name);
  readonly client: NeemoClient;
  /** Até onde cada canal já foi lido. Em memória: depois de reiniciar, relê as últimas 24 h. */
  private readonly readUntil = new Map<string, Date>();

  constructor(
    private readonly db: DatabaseService,
    private readonly connectors: ConnectorsService,
    private readonly inbound: InboundService,
    private readonly notices: OrderNoticeService,
    private readonly fraud: FraudService,
    @InjectQueue(QUEUES.neemo) private readonly queue: Queue,
    @Inject(ENV) env: Env,
  ) {
    this.client = new NeemoClient(env);
  }

  async onModuleInit(): Promise<void> {
    // Idempotente entre réplicas.
    if (this.client.configured) await this.queue.upsertJobScheduler("neemo-polling", { every: POLL_EVERY_MS }, { name: "poll" });
  }

  async poll(): Promise<void> {
    // O agendamento fica no Redis: um processo sem a API configurada pode receber o job e só o ignora.
    if (!this.client.configured) return;
    const channels = await this.db.client.$queryRaw<{ id: string; tenant_id: string }[]>`
      SELECT id, tenant_id FROM app.neemo_channels()`;
    for (const { id, tenant_id: tenantId } of channels) {
      try {
        await this.pollChannel({ id, tenantId, type: "NEEMO" });
      } catch (error) {
        // Segue para as outras lojas; esta relê o mesmo período na próxima rodada.
        this.logger.warn({ tenantId, channelId: id, err: error }, "Pedidos da Neemo não lidos");
        Sentry.captureException(error, { tags: { tenantId, channel: "neemo" } });
      }
    }
  }

  async pollChannel(channel: ResolvedChannel): Promise<void> {
    const startedAt = new Date();
    const token = await this.tokenOf(channel);
    if (!token) return;
    const oldest = startedAt.getTime() - MAX_LOOKBACK_MS;
    const since = new Date(Math.max(this.readUntil.get(channel.id)?.getTime() ?? oldest, oldest));

    for (let page = 1; ; page++) {
      const { orders, total } = await this.client.orders(token, { modified: since, page, sort: "updated_at asc" });
      for (const summary of orders) {
        const stage = neemoStage(summary.status, summary.forma_entrega);
        if (!stage) continue;
        const { status } = stage;
        const at = new Date(summary.updated_at);
        const updated = await this.updateStatus(channel, summary.id, status, stage.event, at);
        if (!updated) {
          const created = await this.createOrder(channel, await this.client.order(token, summary.id));
          if (created && status !== "DELIVERED" && status !== "CANCELED") await this.fraud.orderArrived(channel.tenantId, created);
        } else if (updated.changed && (status === "READY" || status === "DISPATCHED" || status === "DELIVERED")) {
          await this.notices.statusChanged(channel.tenantId, updated.id, status);
        } else if (updated.changed && status === "CANCELED") {
          // Cancelado fora do Dish Desk: a Neemo não informa o motivo.
          await this.db.withTenants({ tenantIds: [channel.tenantId] }, (tx) => tx.order.update({ where: { id: updated.id }, data: { canceledAt: at } }));
        }
      }
      if (orders.length === 0 || page * NEEMO_ORDERS_PAGE >= total) break;
    }
    // Só avança depois de processar tudo: com erro, a próxima rodada relê o mesmo período.
    this.readUntil.set(channel.id, new Date(startedAt.getTime() - OVERLAP_MS));
  }

  /**
   * Importa uma página da base de clientes da loja (feito ao conectar) e agenda a próxima. Cada página é um job: o
   * polling de pedidos continua rodando entre elas e um erro repete só a página. Cliente já importado fica como está.
   */
  async importCustomers(data: NeemoImportJob): Promise<void> {
    if (!this.client.configured) return;
    const token = await this.tokenOf({ id: data.channelId, tenantId: data.tenantId, type: "NEEMO" });
    if (!token) return; // desconectada no meio da importação
    const customers = await this.client.customers(token, data.page);

    let imported = data.imported;
    for (let start = 0; start < customers.length; start += CUSTOMERS_PER_TRANSACTION) {
      await this.db.withTenants({ tenantIds: [data.tenantId] }, async (tx) => {
        for (const customer of customers.slice(start, start + CUSTOMERS_PER_TRANSACTION)) {
          if (await this.importCustomer(tx, data.tenantId, customer)) imported++;
        }
      });
    }
    if (customers.length === NEEMO_CUSTOMERS_PAGE) {
      const next: NeemoImportJob = { ...data, page: data.page + 1, imported };
      await this.queue.add("import-customers", next, { delay: CUSTOMERS_PAGE_INTERVAL_MS });
    } else {
      this.logger.log({ tenantId: data.tenantId, channelId: data.channelId, imported }, "Base de clientes da Neemo importada");
    }
  }

  /**
   * Cliente da base: junta ao cadastro com o mesmo telefone (só completa o que falta) ou cria um novo, que fica sem
   * "último contato" até falar com o restaurante. Cliente sem telefone válido nem e-mail fica de fora: se fizer um
   * pedido, entra por ele. Devolve false se o cliente não entrou ou já estava ligado ao cadastro.
   */
  private async importCustomer(tx: TenantTx, tenantId: string, customer: NeemoCustomer): Promise<boolean> {
    const identityKey = { tenantId, channelType: "NEEMO" as const, externalId: customer.id };
    const known = await tx.contactIdentity.findUnique({ where: { tenantId_channelType_externalId: identityKey }, select: { id: true } });
    if (known) return false;

    const phone = customer.phone ? customerPhone(`${customer.ddd ?? ""}${customer.phone}`) : null;
    const name = customer.name?.trim() || null;
    const email = customer.email?.trim() || null;
    if (!phone && !email) return false;
    const existing = phone ? await tx.contact.findFirst({ where: { phone, deletedAt: null } }) : null;
    const contact = existing
      ? await tx.contact.update({
          where: { id: existing.id },
          data: { ...(!existing.name && name && { name }), ...(!existing.email && email && { email }) },
        })
      : await tx.contact.create({ data: { tenantId, name, email, ...(phone && { phone, phoneSource: "channel", phoneStatus: "ok" }) } });
    const profile = { ...(name && { name }), ...(phone && { phone }), ...(email && { email }) };
    await tx.contactIdentity.create({ data: { ...identityKey, contactId: contact.id, profile } });
    return true;
  }

  /**
   * Importa uma página do histórico de pedidos da loja (todos, desde o primeiro) e agenda a próxima. Os pedidos entram
   * no cadastro de cada cliente, marcados como importados: contam nos pedidos e no total gasto do cliente, nas tags (VIP,
   * Recorrente, Sumido...) e no alerta de fraude, mas ficam fora da aba Pedidos. Vêm da lista, sem os itens (abrir cada
   * pedido seriam dezenas de milhares de consultas). O que não foi cancelado entra como entregue: um pedido antigo que
   * ficou "novo" ou "confirmado" na Neemo não pode parecer na cozinha. Ao terminar, as tags são recalculadas.
   */
  async importOrderHistory(data: NeemoHistoryJob): Promise<void> {
    if (!this.client.configured) return;
    const scope = { tenantIds: [data.tenantId] };
    const save = (patch: Partial<OrderHistoryImport>) =>
      this.db.withTenants(scope, async (tx) => {
        const { orderHistoryImport } = await tx.channel.findUniqueOrThrow({ where: { id: data.channelId }, select: { orderHistoryImport: true } });
        const current = orderHistoryImport as OrderHistoryImport;
        // `from`: o pedido mais antigo alcançado até agora.
        const from = [current.from, patch.from].filter((value): value is string => Boolean(value)).sort()[0] ?? null;
        const state = { ...current, ...patch, from, imported: patch.imported ?? data.imported, updatedAt: new Date().toISOString() };
        await tx.channel.update({ where: { id: data.channelId }, data: { orderHistoryImport: state } });
      });
    const resolved: ResolvedChannel = { id: data.channelId, tenantId: data.tenantId, type: "NEEMO" };
    const token = await this.tokenOf(resolved);
    if (!token) return save({ status: data.imported > 0 ? "partial" : "error" }); // desconectada no meio da importação

    let { imported, seen } = data;
    try {
      const { orders, total } = await this.client.orders(token, { page: data.page, sort: "id desc" });
      const recent = Date.parse(data.until) - HISTORY_RECENT_MS;
      const old = orders.filter((order) => Date.parse(order.date) < recent);
      const known = new Set(
        (
          await this.db.withTenants(scope, (tx) =>
            tx.order.findMany({ where: { channelId: data.channelId, externalOrderId: { in: old.map((order) => order.id) } }, select: { externalOrderId: true } }),
          )
        ).map((order) => order.externalOrderId),
      );
      for (const order of old) {
        if (!known.has(order.id) && (await this.createOrder(resolved, order, new Date()))) imported++;
      }
      seen += orders.length;
      const oldest = orders.map((order) => new Date(order.date).toISOString()).sort()[0];
      if (orders.length === 0 || data.page * NEEMO_ORDERS_PAGE >= total) {
        await save({ status: "done", progress: 100, imported, from: oldest });
        await this.db.withTenants(scope, (tx) => refreshContactTags(tx));
        return;
      }
      await save({ progress: Math.min(99, Math.round((seen / total) * 100)), imported, from: oldest });
      const next: NeemoHistoryJob = { ...data, page: data.page + 1, seen, imported };
      await this.queue.add("import-orders", next, { delay: HISTORY_PAGE_INTERVAL_MS });
    } catch (error) {
      this.logger.warn({ tenantId: data.tenantId, channelId: data.channelId, err: error }, "Histórico de pedidos da Neemo não importado");
      await save({ status: imported > 0 ? "partial" : "error", imported });
    }
  }

  /** Token da loja; null se a integração foi desconectada. */
  private async tokenOf(channel: ResolvedChannel): Promise<string | null> {
    const row = await this.db.withTenants({ tenantIds: [channel.tenantId] }, (tx) =>
      tx.channel.findFirst({ where: { id: channel.id, status: "CONNECTED" }, select: { credentials: true } }),
    );
    return row ? this.connectors.secrets(row.credentials).accessToken : null;
  }

  /**
   * Atualiza o status de um pedido já gravado e registra a etapa na linha do tempo; devolve null se o pedido ainda não
   * existe e, se existe, se o status mudou. A API não informa o horário de cada etapa: vale o da alteração (`at`) em
   * que o polling viu o status pela primeira vez.
   */
  private updateStatus(
    channel: ResolvedChannel,
    externalOrderId: string,
    status: OrderStatus,
    stage: string | undefined,
    at: Date,
  ): Promise<{ id: string; changed: boolean } | null> {
    return this.db.withTenants({ tenantIds: [channel.tenantId] }, async (tx) => {
      const order = await tx.order.findUnique({
        where: { channelId_externalOrderId: { channelId: channel.id, externalOrderId } },
        select: { id: true, status: true, dispatchedAt: true, deliveredAt: true },
      });
      if (!order) return null;
      if (stage) {
        await tx.orderEvent.createMany({
          data: { tenantId: channel.tenantId, orderId: order.id, externalEventId: stage, code: stage, occurredAt: at },
          skipDuplicates: true,
        });
      }
      const changed = order.status !== status;
      if (changed) {
        await tx.order.update({
          where: { id: order.id },
          data: {
            status,
            ...(status === "DISPATCHED" && !order.dispatchedAt && { dispatchedAt: at }),
            ...(status === "DELIVERED" && !order.deliveredAt && { deliveredAt: at }),
          },
        });
      }
      return { id: order.id, changed };
    });
  }

  /**
   * Pedido novo: cliente (pelo telefone), endereço e o pedido com os itens. Pedido sem cliente nem telefone fica de
   * fora. `importedAt`: veio do histórico da loja, então não conta como contato recente do cliente e, se não foi
   * cancelado, entra como entregue. Devolve o id do pedido.
   */
  private async createOrder(channel: ResolvedChannel, order: NeemoOrder, importedAt?: Date): Promise<string | null> {
    const phone = order.phone ? customerPhone(order.phone) : null;
    const externalContactId = order.client_id ?? phone;
    if (!externalContactId) return null;
    const cpf = order.cpf?.replace(/\D/g, "");
    const email = order.email?.trim();
    const at = new Date(order.date);
    const takeout = order.forma_entrega === NEEMO_TAKEOUT;
    const address = !takeout && order.street?.trim() && order.city?.trim() ? order : null;
    const deliveryAddress = address && {
      street: address.street!.trim(),
      number: address.number || null,
      complement: address.complement || null,
      reference: address.reference_point || null,
      neighborhood: address.neighborhood || null,
      city: address.city!.trim(),
      state: address.uf || null,
      postal_code: address.cep || null,
    };
    const current = neemoStage(order.status, order.forma_entrega);
    const canceled = current?.status === "CANCELED";
    const stage = importedAt && !canceled ? ({ status: "DELIVERED", event: "DELIVERED" } as const) : current;

    return this.db.withTenants({ tenantIds: [channel.tenantId] }, async (tx) => {
      const contact = await this.inbound.resolveContact(tx, channel.tenantId, {
        channelType: "NEEMO",
        externalContactId,
        historical: Boolean(importedAt),
        contactProfile: {
          ...(order.name?.trim() && { name: order.name.trim() }),
          ...(phone && { phone }),
          ...(email && { email }),
          ...(cpf && isValidCpf(cpf) && { cpf }),
        },
        timestamp: at,
      });
      if (deliveryAddress) {
        await rememberAddress(tx, contact, "Entrega Neemo", {
          street: deliveryAddress.street,
          number: deliveryAddress.number,
          complement: deliveryAddress.complement,
          district: deliveryAddress.neighborhood,
          city: deliveryAddress.city,
          state: deliveryAddress.state ?? "",
          zipCode: deliveryAddress.postal_code,
        });
      }
      const created = await tx.order.create({
        data: {
          tenantId: channel.tenantId,
          contactId: contact.id,
          channelId: channel.id,
          externalOrderId: order.id,
          displayCode: order.order_number ?? null,
          status: stage?.status ?? "PLACED",
          ...(canceled && { canceledAt: new Date(order.updated_at) }),
          ...(importedAt && { importedAt }),
          subtotal: order.sub_total,
          deliveryFee: order.tax,
          total: order.total,
          deliveryAddress: deliveryAddress ?? undefined,
          placedAt: at,
          // `order_type` é o campo que a previsão de entrega lê para saber que é retirada (como no Cardápio Web).
          raw: { ...order, order_type: takeout ? "takeout" : "delivery" } as Prisma.InputJsonObject,
          items: { create: itemsOf(order, channel.tenantId) },
          events: { create: stagesOf(order, stage?.event).map((event) => ({ tenantId: channel.tenantId, externalEventId: event.code, ...event })) },
        },
        select: { id: true },
      });
      return created.id;
    });
  }
}

/** "86999999999" (DDD + número, como a Neemo manda) → "+5586999999999"; aceita também o número já com o código do país. */
function customerPhone(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  return toE164(`+55${digits}`) ?? toE164(`+${digits}`);
}

/** Itens, pizzas e combos do pedido; o total de cada linha já inclui os complementos escolhidos. */
function itemsOf(order: NeemoOrder, tenantId: string) {
  const line = (name: string, quantity: number, total: number, notes: string | null, options: string[] = []) => ({
    tenantId,
    name,
    quantity: Math.max(1, Math.round(quantity)),
    unitPrice: Math.round((total / (quantity || 1)) * 100) / 100,
    notes,
    options,
  });
  return [
    ...order.ItemOrder.map((item) =>
      line(
        item.name?.trim() || item.title?.trim() || "Item",
        item.quantity,
        item.total,
        item.notes?.trim() || null,
        item.ComplementCategories.flatMap((category) => category.Complements.map((complement) => `${complement.quantity}× ${complement.title}`)),
      ),
    ),
    ...(order.PizzaOrders ?? []).map((pizza) => line(pizza.name?.trim() || pizza.title?.trim() || "Pizza", pizza.quantity, pizza.total, null)),
    ...(order.ComboOrders ?? []).map((combo) => line(combo.name?.trim() || combo.title?.trim() || "Combo", combo.quantity, combo.total, null)),
  ];
}

/** Linha do tempo de um pedido lido pela primeira vez: quando foi feito e, se já passou disso, a etapa em que está. */
function stagesOf(order: NeemoOrder, current: string | undefined): { code: string; occurredAt: Date }[] {
  return [
    { code: "PLACED", occurredAt: new Date(order.date) },
    ...(current && current !== "PLACED" ? [{ code: current, occurredAt: new Date(order.updated_at) }] : []),
  ];
}

@Processor(QUEUES.neemo)
export class NeemoProcessor extends JobProcessor {
  constructor(private readonly neemo: NeemoService) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name === "import-customers") await this.neemo.importCustomers(job.data as NeemoImportJob);
    else if (job.name === "import-orders") await this.neemo.importOrderHistory(job.data as NeemoHistoryJob);
    else await this.neemo.poll();
  }
}
