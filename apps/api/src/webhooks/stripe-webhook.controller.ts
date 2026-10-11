import {
  Controller,
  Headers,
  HttpCode,
  Inject,
  Post,
  type RawBodyRequest,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { Public } from "../auth/auth.decorators.js";
import { verifyStripeSignature } from "../billing/stripe.js";
import { ENV, type Env } from "../config/env.js";
import { DatabaseService } from "../core/database.service.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// A fatura da renovação é cobrada cerca de uma hora depois de o período virar, e um cartão recusado é tentado de novo
// por alguns dias: o restaurante só bloqueia se a renovação não chegar dentro desta folga.
const RENEWAL_GRACE_MS = 3 * DAY_MS;

const Event = z.looseObject({ type: z.string(), data: z.looseObject({ object: z.unknown() }) });

const CheckoutSession = z.looseObject({
  id: z.string(),
  mode: z.string(),
  payment_status: z.string(),
  client_reference_id: z.uuid(),
  customer: z.string().nullish(),
  // Fatura da primeira mensalidade (só no modo assinatura): o evento invoice.paid dela não conta de novo.
  invoice: z.string().nullish(),
  amount_total: z.number(),
  created: z.number(),
});

const Invoice = z.looseObject({
  id: z.string(),
  customer: z.string(),
  amount_paid: z.number(),
  lines: z.looseObject({ data: z.array(z.looseObject({ period: z.looseObject({ end: z.number() }) })).min(1) }),
});

/** Webhook da Stripe: libera o restaurante quando o pagamento da assinatura é confirmado. */
@Public()
@Controller("webhooks/stripe")
export class StripeWebhookController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DatabaseService,
  ) {}

  @Post()
  @HttpCode(200)
  async receive(@Req() request: RawBodyRequest<Request>, @Headers("stripe-signature") signature: string | undefined): Promise<string> {
    if (!this.env.STRIPE_WEBHOOK_SECRET) throw new ServiceUnavailableException("Webhook da Stripe não configurado.");
    const { rawBody } = request;
    if (!rawBody || !verifyStripeSignature(rawBody, signature, this.env.STRIPE_WEBHOOK_SECRET)) throw new UnauthorizedException();

    // Evento que não é de um checkout nosso (outro formato, sem o restaurante) é ignorado: responder erro só faria
    // a Stripe reenviar por dias.
    const event = Event.parse(request.body);
    // O Pix pode confirmar depois de o cliente sair da página: aí chega async_payment_succeeded.
    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      const { data: session } = CheckoutSession.safeParse(event.data.object);
      if (session?.payment_status !== "paid") return "ok";
      if (session.mode === "subscription") {
        const paidUntil = new Date(session.created * 1000);
        paidUntil.setMonth(paidUntil.getMonth() + 1);
        await this.record(session.invoice ?? session.id, session.client_reference_id, session.customer, "MONTHLY", session.amount_total, paidUntil);
      } else {
        await this.record(session.id, session.client_reference_id, session.customer, "ANNUAL", session.amount_total, null);
      }
    } else if (event.type === "invoice.paid") {
      // Renovação da mensalidade: o restaurante é o do cliente da Stripe, gravado no primeiro pagamento.
      const { data: invoice } = Invoice.safeParse(event.data.object);
      if (!invoice) return "ok";
      const periodEnd = Math.max(...invoice.lines.data.map((line) => line.period.end));
      await this.record(invoice.id, null, invoice.customer, "MONTHLY", invoice.amount_paid, new Date(periodEnd * 1000));
    }
    return "ok";
  }

  private async record(
    id: string,
    tenantId: string | null,
    customerId: string | null | undefined,
    plan: "MONTHLY" | "ANNUAL",
    amountCents: number,
    periodEnd: Date | null,
  ): Promise<void> {
    const paidUntil = periodEnd && new Date(periodEnd.getTime() + RENEWAL_GRACE_MS);
    await this.db.client.$executeRaw`
      SELECT app.record_tenant_payment(
        ${id}, ${tenantId}::uuid, ${customerId ?? null}, ${plan}::"BillingPlan", ${amountCents}::int, ${paidUntil}::timestamptz
      )`;
  }
}
