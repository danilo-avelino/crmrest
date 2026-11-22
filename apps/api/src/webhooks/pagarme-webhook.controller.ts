import { timingSafeEqual } from "node:crypto";
import { Body, Controller, Headers, HttpCode, Inject, Logger, Post, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { z } from "zod";
import { Public } from "../auth/auth.decorators.js";
import { ENV, type Env } from "../config/env.js";
import { PublicOrderService } from "../public/public-order.service.js";

const Event = z.looseObject({
  type: z.string(),
  data: z.looseObject({ id: z.string(), code: z.uuid().optional(), order: z.looseObject({ id: z.string(), code: z.uuid().optional() }).optional() }),
});

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Webhook da Pagar.me (F6-03): só avisa. Quem decide é a consulta da situação na própria Pagar.me (settle), então um aviso
 * forjado não paga nada; mesmo assim o endpoint exige o Basic Auth configurado no painel da Pagar.me. Repetido não duplica:
 * o pagamento só passa de PENDING para PAID uma vez.
 */
@Public()
@Controller("webhooks/pagarme")
export class PagarmeWebhookController {
  private readonly logger = new Logger(PagarmeWebhookController.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly orders: PublicOrderService,
  ) {}

  @Post()
  @HttpCode(200)
  async receive(@Body() body: unknown, @Headers("authorization") authorization: string | undefined): Promise<string> {
    if (!this.env.PAGARME_WEBHOOK_USER || !this.env.PAGARME_WEBHOOK_PASSWORD) throw new ServiceUnavailableException("Webhook da Pagar.me não configurado.");
    const expected = `Basic ${Buffer.from(`${this.env.PAGARME_WEBHOOK_USER}:${this.env.PAGARME_WEBHOOK_PASSWORD}`).toString("base64")}`;
    if (!authorization || !same(authorization, expected)) throw new UnauthorizedException();
    const { data: event } = Event.safeParse(body);
    if (!event) return "ok";
    // order.* traz o pedido; charge.* traz a cobrança com o pedido dentro.
    const providerOrderId = event.type.startsWith("order.") ? event.data.id : event.data.order?.id;
    const paymentId = event.type.startsWith("order.") ? event.data.code : event.data.order?.code;
    if (!providerOrderId || !paymentId) return "ok";
    try {
      await this.orders.providerNotified(paymentId, providerOrderId);
    } catch (error) {
      this.logger.warn(`Aviso da Pagar.me ${event.type} não tratado: ${error instanceof Error ? error.message : String(error)}`);
    }
    return "ok";
  }
}
