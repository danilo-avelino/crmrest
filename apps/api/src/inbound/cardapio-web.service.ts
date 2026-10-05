import type { Prisma } from "@comanda/database";
import type { OrderStatus } from "@comanda/database/enums";
import { isValidCpf, toE164 } from "@comanda/shared";
import { InjectQueue, Processor } from "@nestjs/bullmq";
import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import * as Sentry from "@sentry/nestjs";
import type { Queue } from "bullmq";
import { ENV, type Env } from "../config/env.js";
import { CARDAPIO_WEB_STATUS, CardapioWebClient, type CardapioWebOrder } from "../connectors/cardapio-web.client.js";
import { ConnectorsService } from "../connectors/connectors.service.js";
import { DatabaseService } from "../core/database.service.js";
import { JobProcessor } from "../queues/job-processor.js";
import { QUEUES } from "../queues/queues.module.js";
import { InboundService, type ResolvedChannel } from "./inbound.service.js";
import { rememberAddress } from "./orders.js";

/** A API só aceita `updated_since` de até 24 h atrás (erro 400 além disso): é o máximo que uma leitura volta. */
const MAX_LOOKBACK_MS = 23 * 60 * 60 * 1000 + 50 * 60 * 1000;
/** Cada polling relê um pouco antes de onde parou: a leitura é idempotente e tolera relógios desencontrados. */
const OVERLAP_MS = 60_000;

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
      const known = await this.updateStatus(channel, summary.id, status, new Date(summary.updated_at));
      if (!known) await this.createOrder(channel, await this.client.order(apiKey, summary.id));
    }
    // Só avança depois de processar tudo: com erro, a próxima rodada relê o mesmo período.
    this.readUntil.set(channel.id, new Date(startedAt.getTime() - OVERLAP_MS));
  }

  /** Atualiza o status de um pedido já gravado; devolve false se o pedido ainda não existe. */
  private updateStatus(channel: ResolvedChannel, externalOrderId: string, status: OrderStatus, at: Date): Promise<boolean> {
    return this.db.withTenants({ tenantIds: [channel.tenantId] }, async (tx) => {
      const order = await tx.order.findUnique({
        where: { channelId_externalOrderId: { channelId: channel.id, externalOrderId } },
        select: { id: true, status: true, dispatchedAt: true, deliveredAt: true },
      });
      if (!order) return false;
      if (order.status !== status) {
        await tx.order.update({
          where: { id: order.id },
          data: {
            status,
            ...(status === "DISPATCHED" && !order.dispatchedAt && { dispatchedAt: at }),
            ...(status === "DELIVERED" && !order.deliveredAt && { deliveredAt: at }),
          },
        });
      }
      return true;
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

  async process(): Promise<void> {
    await this.cardapioWeb.poll();
  }
}
