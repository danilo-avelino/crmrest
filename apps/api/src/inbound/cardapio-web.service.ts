import type { Prisma, TenantTx } from "@dishdesk/database";
import type { OrderStatus } from "@dishdesk/database/enums";
import { isValidCpf, toE164 } from "@dishdesk/shared";
import { InjectQueue, Processor } from "@nestjs/bullmq";
import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import * as Sentry from "@sentry/nestjs";
import type { Job, Queue } from "bullmq";
import { ENV, type Env } from "../config/env.js";
import { CARDAPIO_WEB_STATUS, CardapioWebClient, type CardapioWebCustomer, type CardapioWebOrder } from "../connectors/cardapio-web.client.js";
import { ConnectorsService } from "../connectors/connectors.service.js";
import { DatabaseService } from "../core/database.service.js";
import { OrderNoticeService } from "../orders/order-notice.service.js";
import { JobProcessor } from "../queues/job-processor.js";
import { type CardapioWebImportJob, QUEUES } from "../queues/queues.module.js";
import { InboundService, type ResolvedChannel } from "./inbound.service.js";
import { rememberAddress } from "./orders.js";

/** A API só aceita `updated_since` de até 24 h atrás (erro 400 além disso): é o máximo que uma leitura volta. */
const MAX_LOOKBACK_MS = 23 * 60 * 60 * 1000 + 50 * 60 * 1000;
/** Cada polling relê um pouco antes de onde parou: a leitura é idempotente e tolera relógios desencontrados. */
const OVERLAP_MS = 60_000;
/** A API de clientes aceita 300 requisições a cada 3 minutos: uma página a cada 0,6 s fica dentro do limite. */
const CUSTOMERS_PAGE_INTERVAL_MS = 600;

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
      const updated = await this.updateStatus(channel, summary.id, status, new Date(summary.updated_at));
      if (!updated) await this.createOrder(channel, await this.client.order(apiKey, summary.id));
      else if (updated.changed && (status === "DISPATCHED" || status === "DELIVERED")) {
        await this.notices.statusChanged(channel.tenantId, updated.id, status);
      }
    }
    // Só avança depois de processar tudo: com erro, a próxima rodada relê o mesmo período.
    this.readUntil.set(channel.id, new Date(startedAt.getTime() - OVERLAP_MS));
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

  /** Atualiza o status de um pedido já gravado; devolve null se o pedido ainda não existe e, se existe, se o status mudou. */
  private updateStatus(
    channel: ResolvedChannel,
    externalOrderId: string,
    status: OrderStatus,
    at: Date,
  ): Promise<{ id: string; changed: boolean } | null> {
    return this.db.withTenants({ tenantIds: [channel.tenantId] }, async (tx) => {
      const order = await tx.order.findUnique({
        where: { channelId_externalOrderId: { channelId: channel.id, externalOrderId } },
        select: { id: true, status: true, dispatchedAt: true, deliveredAt: true },
      });
      if (!order) return null;
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

  /** Pedido novo: cliente (pelo telefone), endereço e o pedido com os itens. Pedidos sem cliente (mesa, balcão) ficam de fora. */
  private async createOrder(channel: ResolvedChannel, order: CardapioWebOrder): Promise<void> {
    const customer = order.customer;
    const phone = customer?.phone ? customerPhone(customer.phone, customer.ddi) : null;
    const externalContactId = customer?.id ?? phone;
    if (!externalContactId) return;
    const cpf = order.fiscal_document?.replace(/\D/g, "");
    const at = new Date(order.created_at);

    await this.db.withTenants({ tenantIds: [channel.tenantId] }, async (tx) => {
      const contact = await this.inbound.resolveContact(tx, channel.tenantId, {
        channelType: "CARDAPIO_WEB",
        externalContactId,
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
      await tx.order.create({
        data: {
          tenantId: channel.tenantId,
          contactId: contact.id,
          channelId: channel.id,
          externalOrderId: order.id,
          displayCode: order.display_id ?? null,
          status: CARDAPIO_WEB_STATUS[order.status] ?? "PLACED",
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
        },
      });
    });
  }
}

/** "85994197929" + DDI "55" → "+5585994197929"; aceita também o número já com o código do país. */
function customerPhone(phone: string, ddi: string | null | undefined): string | null {
  const digits = phone.replace(/\D/g, "");
  return toE164(`+${ddi?.replace(/\D/g, "") || "55"}${digits}`) ?? toE164(digits);
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
    else await this.cardapioWeb.poll();
  }
}
