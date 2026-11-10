import { BILLING_PLANS } from "@dishdesk/shared";
import { Body, Controller, HttpCode, Inject, Logger, Post, ServiceUnavailableException } from "@nestjs/common";
import { z } from "zod";
import { Public } from "../auth/auth.decorators.js";
import { paidAmount, tenantOfOrder } from "../billing/infinitepay.js";
import { cancelOtherSubscriptions } from "../billing/stripe.js";
import { ENV, type Env } from "../config/env.js";
import { DatabaseService } from "../core/database.service.js";

const Payment = z.looseObject({ invoice_slug: z.string().min(1), transaction_nsu: z.string().min(1), order_nsu: z.string().min(1) });

/** Webhook da InfinitePay: libera o restaurante por um ano quando o pagamento do plano anual é confirmado. */
@Public()
@Controller("webhooks/infinitepay")
export class InfinitepayWebhookController {
  private readonly logger = new Logger(InfinitepayWebhookController.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DatabaseService,
  ) {}

  @Post()
  @HttpCode(200)
  async receive(@Body() body: unknown): Promise<string> {
    if (!this.env.INFINITEPAY_HANDLE || !this.env.INFINITEPAY_API_KEY) throw new ServiceUnavailableException("Webhook da InfinitePay não configurado.");
    // Aviso que não é de um link nosso é ignorado: responder erro só faria a InfinitePay reenviar.
    const { data: payment } = Payment.safeParse(body);
    const tenantId = payment && tenantOfOrder(payment.order_nsu);
    if (!payment || !tenantId) return "ok";

    const amount = await paidAmount(this.env, {
      orderNsu: payment.order_nsu,
      transactionNsu: payment.transaction_nsu,
      slug: payment.invoice_slug,
    });
    // Qualquer um cria um link com a nossa handle: só o valor do plano anual libera o restaurante.
    if (amount !== BILLING_PLANS.annual.amountCents) {
      if (amount !== null) this.logger.warn(`Pagamento ${payment.transaction_nsu} da InfinitePay com valor ${amount}: ignorado.`);
      return "ok";
    }
    await this.db.client.$executeRaw`
      SELECT app.record_tenant_payment(
        ${`infinitepay:${payment.transaction_nsu}`}, ${tenantId}::uuid, NULL, 'ANNUAL'::"BillingPlan", ${amount}::int, NULL
      )`;

    // Quem assinava o mensal na Stripe e pagou o anual: a assinatura mensal é cancelada.
    if (!this.env.STRIPE_SECRET_KEY) return "ok";
    const tenant = await this.db.withTenants({ tenantIds: [tenantId] }, (tx) =>
      tx.tenant.findUnique({ where: { id: tenantId }, select: { stripeCustomerId: true } }),
    );
    if (tenant?.stripeCustomerId) await cancelOtherSubscriptions(this.env, tenant.stripeCustomerId, null);
    return "ok";
  }
}
