import type { Prisma, TenantTx } from "@dishdesk/database";
import type { OrderStatus } from "@dishdesk/database/enums";
import { isValidCpf, type OrderHistoryImport, toE164 } from "@dishdesk/shared";
import { InjectQueue, Processor } from "@nestjs/bullmq";
import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import * as Sentry from "@sentry/nestjs";
import type { Job, Queue } from "bullmq";
import { ENV, type Env } from "../config/env.js";
import {
  CARDAPIO_WEB_EVENT,
  CARDAPIO_WEB_STATUS,
  CardapioWebClient,
  type CardapioWebCustomer,
  type CardapioWebOrder,
  CardapioWebPeriodError,
} from "../connectors/cardapio-web.client.js";
import { ConnectorsService } from "../connectors/connectors.service.js";
import { DatabaseService } from "../core/database.service.js";
import { FraudService } from "../orders/fraud.service.js";
import { OrderNoticeService } from "../orders/order-notice.service.js";
import { JobProcessor } from "../queues/job-processor.js";
import { type CardapioWebHistoryJob, type CardapioWebImportJob, QUEUES } from "../queues/queues.module.js";
import { InboundService, type ResolvedChannel } from "./inbound.service.js";
import { rememberAddress } from "./orders.js";

/** A API só aceita `updated_since` de até 24 h atrás (erro 400 além disso): é o máximo que uma leitura volta. */
const MAX_LOOKBACK_MS = 23 * 60 * 60 * 1000 + 50 * 60 * 1000;
/** Cada polling relê um pouco antes de onde parou: a leitura é idempotente e tolera relógios desencontrados. */
const OVERLAP_MS = 60_000;
/** A API de clientes aceita 300 requisições a cada 3 minutos: uma página a cada 0,6 s fica dentro do limite. */
const CUSTOMERS_PAGE_INTERVAL_MS = 600;
/** O histórico de pedidos aceita 5 consultas por minuto e um período de até 6 meses por consulta. */
const HISTORY_PAGE_INTERVAL_MS = 12_500;
const HISTORY_WINDOW_MONTHS = 6;
/** A documentação diz ora 1 ano, ora 3 anos: tenta até 3 anos e para quando a API recusar o período. */
const HISTORY_WINDOWS = 6;
/** Os detalhes de cada pedido contam no limite geral (300 a cada 3 minutos). */
const ORDER_DETAIL_INTERVAL_MS = 600;

/**
 * Pedidos do Cardápio Web (cardápio digital do restaurante). Eles trazem o telefone, então entram no cadastro
 * do cliente (o mesmo do WhatsApp) sem abrir conversa: o atendimento continua no WhatsApp.
 */
@Injectable()
export class CardapioWebService implements OnModuleInit {
  private readonly logger = new Logger(CardapioWebService.name);
  readonly client: CardapioWebClient;
  /** Até onde cada canal já foi lido. Em memória: depois de reiniciar, relê as últimas 24 h. */
  private readonly readUntil = new Map<string, Date>();

  constructor(
    private readonly db: DatabaseService,
    private readonly connectors: ConnectorsService,
    private readonly inbound: InboundService,
    private readonly notices: OrderNoticeService,
    private readonly fraud: FraudService,
    @InjectQueue(QUEUES.cardapioWeb) private readonly queue: Queue,
    @Inject(ENV) env: Env,
  ) {
    this.client = new CardapioWebClient(env);
  }

  async onModuleInit(): Promise<void> {
    // A cada 30s, como a documentação recomenda. Idempotente entre réplicas.
    if (this.client.configured) await this.queue.upsertJobScheduler("cardapio-web-polling", { every: 30_000 }, { name: "poll" });
  }

  async poll(): Promise<void> {
    // O agendamento fica no Redis: um processo sem a API configurada pode receber o job e só o ignora.
    if (!this.client.configured) return;
    const channels = await this.db.client.$queryRaw<{ id: string; tenant_id: string }[]>`
      SELECT id, tenant_id FROM app.cardapio_web_channels()`;
    for (const { id, tenant_id: tenantId } of channels) {
      try {
        await this.pollChannel({ id, tenantId, type: "CARDAPIO_WEB" });
      } catch (error) {
        // Segue para as outras lojas; esta relê o mesmo período na próxima rodada.
        this.logger.warn({ tenantId, channelId: id, err: error }, "Pedidos do Cardápio Web não lidos");
        Sentry.captureException(error, { tags: { tenantId, channel: "cardapio_web" } });
      }
    }
  }

  async pollChannel(channel: ResolvedChannel): Promise<void> {
    const startedAt = new Date();
    const { credentials, hasIfood } = await this.db.withTenants({ tenantIds: [channel.tenantId] }, async (tx) => ({
      credentials: (await tx.channel.findUniqueOrThrow({ where: { id: channel.id }, select: { credentials: true } })).credentials,
      hasIfood: (await tx.channel.count({ where: { type: "IFOOD", status: "CONNECTED" } })) > 0,
    }));
    const { accessToken: apiKey } = this.connectors.secrets(credentials);
    // Primeira leitura (ou depois de reiniciar, ou de mais de um dia com erro): volta o máximo que a API permite.
    const oldest = startedAt.getTime() - MAX_LOOKBACK_MS;
    const since = new Date(Math.max(this.readUntil.get(channel.id)?.getTime() ?? oldest, oldest));

    for (const summary of await this.client.updatedOrders(apiKey, since)) {
      // Pedidos do iFood repassados pelo Cardápio Web já chegam pela integração direta com o iFood.
      if (hasIfood && summary.sales_channel === "ifood") continue;
      const status = CARDAPIO_WEB_STATUS[summary.status];
      if (!status) continue;
      const updated = await this.updateStatus(channel, summary.id, status, CARDAPIO_WEB_EVENT[summary.status], new Date(summary.updated_at));
      if (!updated) {
        const created = await this.createOrder(channel, await this.client.order(apiKey, summary.id));
        if (created && status !== "DELIVERED" && status !== "CANCELED") await this.fraud.orderArrived(channel.tenantId, created);
      } else if (updated.changed && (status === "READY" || status === "DISPATCHED" || status === "DELIVERED")) {
        await this.notices.statusChanged(channel.tenantId, updated.id, status);
      } else if (updated.changed && status === "CANCELED") {
        await this.saveCancellation(channel, apiKey, updated.id, summary.id, new Date(summary.updated_at));
      }
    }
    // Só avança depois de processar tudo: com erro, a próxima rodada relê o mesmo período.
    this.readUntil.set(channel.id, new Date(startedAt.getTime() - OVERLAP_MS));
  }

  /** Cancelado fora do Dish Desk: o motivo vem só nos detalhes do pedido. Sem ele, o alerta mostra "Motivo não informado". */
  private async saveCancellation(channel: ResolvedChannel, apiKey: string, orderId: string, externalOrderId: string, at: Date): Promise<void> {
    let reason: string | null = null;
    try {
      reason = (await this.client.order(apiKey, externalOrderId)).cancellation_reason?.trim() || null;
    } catch (error) {
      this.logger.warn({ tenantId: channel.tenantId, orderId, err: error }, "Motivo do cancelamento não lido");
    }
    await this.db.withTenants({ tenantIds: [channel.tenantId] }, (tx) =>
      tx.order.update({ where: { id: orderId }, data: { canceledAt: at, ...(reason && { cancellationReason: reason }) } }),
    );
  }

  /**
   * Importa uma página dos cancelamentos antigos da loja, para o alerta de fraude considerar o histórico, e agenda a
   * próxima. Só os cancelados: os relatórios e as tags não contam cancelados, então o passado da loja não muda os
   * números de hoje. Cada pedido exige uma consulta (a lista vem sem cliente, motivo nem endereço), daí o ritmo lento.
   */
  async importOrderHistory(data: CardapioWebHistoryJob): Promise<void> {
    if (!this.client.configured) return;
    const scope = { tenantIds: [data.tenantId] };
    const channel = await this.db.withTenants(scope, async (tx) => ({
      row: await tx.channel.findFirst({ where: { id: data.channelId, status: "CONNECTED" }, select: { credentials: true } }),
      hasIfood: (await tx.channel.count({ where: { type: "IFOOD", status: "CONNECTED" } })) > 0,
    }));
    const save = (patch: Partial<OrderHistoryImport>) =>
      this.db.withTenants(scope, async (tx) => {
        const { orderHistoryImport } = await tx.channel.findUniqueOrThrow({ where: { id: data.channelId }, select: { orderHistoryImport: true } });
        const state = { ...(orderHistoryImport as OrderHistoryImport), ...patch, imported: patch.imported ?? data.imported, updatedAt: new Date().toISOString() };
        await tx.channel.update({ where: { id: data.channelId }, data: { orderHistoryImport: state } });
      });
    const failed = () => save({ status: data.imported > 0 || data.window > 0 ? "partial" : "error" });
    if (!channel.row) return failed(); // desconectada no meio da importação

    const until = new Date(data.until);
    const end = monthsBefore(until, data.window * HISTORY_WINDOW_MONTHS);
    const start = monthsBefore(until, (data.window + 1) * HISTORY_WINDOW_MONTHS);
    const { accessToken: apiKey } = this.connectors.secrets(channel.row.credentials);
    const resolved: ResolvedChannel = { id: data.channelId, tenantId: data.tenantId, type: "CARDAPIO_WEB" };
    let imported = data.imported;
    try {
      const { orders, pagination } = await this.client.canceledHistory(apiKey, start, end, data.page);
      const known = new Set(
        (
          await this.db.withTenants(scope, (tx) =>
            tx.order.findMany({ where: { channelId: data.channelId, externalOrderId: { in: orders.map((order) => order.id) } }, select: { externalOrderId: true } }),
          )
        ).map((order) => order.externalOrderId),
      );
      for (const summary of orders) {
        if (known.has(summary.id) || (channel.hasIfood && summary.sales_channel === "ifood")) continue;
        await new Promise((resolve) => setTimeout(resolve, ORDER_DETAIL_INTERVAL_MS));
        if (await this.createOrder(resolved, await this.client.order(apiKey, summary.id), new Date())) imported++;
      }
      const lastPage = data.page >= pagination.total_pages;
      const lastWindow = data.window + 1 >= HISTORY_WINDOWS;
      const done = (data.window + (lastPage ? 1 : data.page / pagination.total_pages)) / HISTORY_WINDOWS;
      if (lastPage && lastWindow) return await save({ status: "done", progress: 100, imported, from: start.toISOString() });
      await save({ progress: Math.round(done * 100), imported, from: start.toISOString() });
      const next: CardapioWebHistoryJob = { ...data, imported, ...(lastPage ? { window: data.window + 1, page: 1 } : { page: data.page + 1 }) };
      await this.queue.add("import-orders", next, { delay: HISTORY_PAGE_INTERVAL_MS });
    } catch (error) {
      // Passou do que a API guarda: terminou. Na primeira consulta, é erro de verdade.
      if (error instanceof CardapioWebPeriodError && data.window > 0) return await save({ status: "done", progress: 100, imported });
      this.logger.warn({ tenantId: data.tenantId, channelId: data.channelId, err: error }, "Histórico de pedidos do Cardápio Web não importado");
      await save({ status: imported > 0 || data.window > 0 ? "partial" : "error", imported });
    }
  }

  /**
   * Importa uma página da base de clientes da loja (feito ao conectar) e agenda a próxima. Cada página é um job: o
   * polling de pedidos continua rodando entre elas e um erro repete só a página. Cliente já importado fica como está.
   */
  async importCustomers(data: CardapioWebImportJob): Promise<void> {
    if (!this.client.configured) return;
    const channel = await this.db.withTenants({ tenantIds: [data.tenantId] }, (tx) =>
      tx.channel.findFirst({ where: { id: data.channelId, status: "CONNECTED" }, select: { credentials: true } }),
    );
    if (!channel) return; // desconectada no meio da importação
    const { accessToken: apiKey } = this.connectors.secrets(channel.credentials);
    const { customers, pagination } = await this.client.customers(apiKey, data.page);

    let imported = data.imported;
    await this.db.withTenants({ tenantIds: [data.tenantId] }, async (tx) => {
      for (const customer of customers) if (await this.importCustomer(tx, data.tenantId, customer)) imported++;
    });
    if (data.page < pagination.total_pages) {
      const next: CardapioWebImportJob = { ...data, page: data.page + 1, imported };
      await this.queue.add("import-customers", next, { delay: CUSTOMERS_PAGE_INTERVAL_MS });
    } else {
      const context = { tenantId: data.tenantId, channelId: data.channelId, imported, total: pagination.total_customers };
      this.logger.log(context, "Base de clientes do Cardápio Web importada");
    }
  }

  /**
   * Cliente da base: junta ao cadastro com o mesmo telefone (só completa o que falta) ou cria um novo, que fica sem
   * "último contato" até falar com o restaurante. Quem desligou as mensagens no Cardápio Web entra sem consentimento
   * de marketing. Cliente sem telefone válido nem e-mail (só nome) fica de fora: se fizer um pedido, entra por ele.
   * Devolve false se o cliente não entrou ou já estava ligado ao cadastro (importação anterior ou pedido).
   */
  private async importCustomer(tx: TenantTx, tenantId: string, customer: CardapioWebCustomer): Promise<boolean> {
    const identityKey = { tenantId, channelType: "CARDAPIO_WEB" as const, externalId: customer.id };
    const known = await tx.contactIdentity.findUnique({ where: { tenantId_channelType_externalId: identityKey }, select: { id: true } });
    if (known) return false;

    const phone = customer.phone_number ? customerPhone(customer.phone_number, customer.ddi) : null;
    const name = customer.name?.trim() || null;
    const email = customer.email?.trim() || null;
    if (!phone && !email) return false;
    const birthDate = customer.birth_date ? new Date(customer.birth_date) : null;
    const existing = phone ? await tx.contact.findFirst({ where: { phone, deletedAt: null } }) : null;
    const contact = existing
      ? await tx.contact.update({
          where: { id: existing.id },
          data: {
            ...(!existing.name && name && { name }),
            ...(!existing.email && email && { email }),
            ...(!existing.birthDate && birthDate && { birthDate }),
          },
        })
      : await tx.contact.create({
          data: {
            tenantId,
            name,
            email,
            birthDate,
            firstSeenAt: new Date(customer.created_at),
            ...(phone && { phone, phoneSource: "channel", phoneStatus: "ok" }),
          },
        });
    const profile = { ...(name && { name }), ...(phone && { phone }), ...(email && { email }) };
    await tx.contactIdentity.create({ data: { ...identityKey, contactId: contact.id, profile } });
    if (customer.notifications_enabled === false) {
      await tx.consent.create({
        data: { tenantId, contactId: contact.id, purpose: "marketing_whatsapp", granted: false, source: "cardapio_web" },
      });
    }
    return true;
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
   * Pedido novo: cliente (pelo telefone), endereço e o pedido com os itens. Pedidos sem cliente (mesa, balcão) ficam de
   * fora. `importedAt`: veio do histórico da loja, então não conta como contato recente do cliente. Devolve o id do pedido.
   */
  private async createOrder(channel: ResolvedChannel, order: CardapioWebOrder, importedAt?: Date): Promise<string | null> {
    const customer = order.customer;
    const phone = customer?.phone ? customerPhone(customer.phone, customer.ddi) : null;
    const externalContactId = customer?.id ?? phone;
    if (!externalContactId) return null;
    const cpf = order.fiscal_document?.replace(/\D/g, "");
    const at = new Date(order.created_at);

    return this.db.withTenants({ tenantIds: [channel.tenantId] }, async (tx) => {
      const contact = await this.inbound.resolveContact(tx, channel.tenantId, {
        channelType: "CARDAPIO_WEB",
        externalContactId,
        historical: Boolean(importedAt),
        contactProfile: {
          ...(customer?.name && { name: customer.name }),
          ...(phone && { phone }),
          ...(cpf && isValidCpf(cpf) && { cpf }),
        },
        timestamp: at,
      });
      const address = order.delivery_address;
      if (address) {
        await rememberAddress(tx, contact, "Entrega Cardápio Web", {
          street: address.street,
          number: address.number,
          complement: address.complement,
          district: address.neighborhood,
          city: address.city,
          state: address.state,
          zipCode: address.postal_code,
        });
      }
      const created = await tx.order.create({
        data: {
          tenantId: channel.tenantId,
          contactId: contact.id,
          channelId: channel.id,
          externalOrderId: order.id,
          displayCode: order.display_id ?? null,
          status: CARDAPIO_WEB_STATUS[order.status] ?? "PLACED",
          ...(order.status === "canceled" && { canceledAt: new Date(order.updated_at), cancellationReason: order.cancellation_reason?.trim() || null }),
          ...(importedAt && { importedAt }),
          subtotal: cents(order.items.reduce((sum, item) => sum + item.total_price, 0)),
          deliveryFee: order.delivery_fee,
          total: order.total,
          deliveryAddress: (address ?? undefined) as Prisma.InputJsonObject | undefined,
          placedAt: at,
          raw: order as Prisma.InputJsonObject,
          items: {
            create: order.items.map((item) => ({
              tenantId: channel.tenantId,
              name: item.name,
              quantity: Math.max(1, Math.round(item.quantity)),
              // total_price inclui os adicionais escolhidos.
              unitPrice: cents(item.total_price / (item.quantity || 1)),
              notes: item.observation ?? null,
            })),
          },
          events: { create: stagesOf(order).map((stage) => ({ tenantId: channel.tenantId, externalEventId: stage.code, ...stage })) },
        },
        select: { id: true },
      });
      return created.id;
    });
  }
}

function monthsBefore(date: Date, months: number): Date {
  const result = new Date(date);
  result.setUTCMonth(result.getUTCMonth() - months);
  return result;
}

/** "85994197929" + DDI "55" → "+5585994197929"; aceita também o número já com o código do país. */
function customerPhone(phone: string, ddi: string | null | undefined): string | null {
  const digits = phone.replace(/\D/g, "");
  return toE164(`+${ddi?.replace(/\D/g, "") || "55"}${digits}`) ?? toE164(digits);
}

/** Linha do tempo de um pedido lido pela primeira vez: quando foi feito e, se já passou disso, a etapa em que está. */
function stagesOf(order: CardapioWebOrder): { code: string; occurredAt: Date }[] {
  const current = CARDAPIO_WEB_EVENT[order.status];
  return [
    { code: "PLACED", occurredAt: new Date(order.created_at) },
    ...(current && current !== "PLACED" ? [{ code: current, occurredAt: new Date(order.updated_at) }] : []),
  ];
}

function cents(value: number): number {
  return Math.round(value * 100) / 100;
}

@Processor(QUEUES.cardapioWeb)
export class CardapioWebProcessor extends JobProcessor {
  constructor(private readonly cardapioWeb: CardapioWebService) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name === "import-customers") await this.cardapioWeb.importCustomers(job.data as CardapioWebImportJob);
    else if (job.name === "import-orders") await this.cardapioWeb.importOrderHistory(job.data as CardapioWebHistoryJob);
    else await this.cardapioWeb.poll();
  }
}
