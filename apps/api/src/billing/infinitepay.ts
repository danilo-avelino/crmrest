import { BILLING_PLANS } from "@dishdesk/shared";
import { z } from "zod";
import type { Env } from "../config/env.js";

// Checkout Integrado da InfinitePay (https://www.infinitepay.io/checkout-documentacao): o plano anual, no cartão em até
// 12x ou no Pix. Não tem cobrança recorrente: o mensal continua na Stripe.

/** Até quantas parcelas as taxas ficam com a gente: o cliente paga o anual em até 10x sem juros (11x e 12x com juros). */
const INTEREST_FREE_INSTALLMENTS = 10;

async function infinitepay(env: Env, path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${env.INFINITEPAY_API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": env.INFINITEPAY_API_KEY ?? "" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`InfinitePay POST ${path}: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}

const Link = z.looseObject({ checkout_url: z.url() });

/**
 * Link de pagamento do plano anual. O order_nsu começa pelo restaurante e volta no webhook; o resto o deixa único,
 * para que outro ano pago depois não reaproveite um link já usado.
 */
export async function createAnnualLink(
  env: Env,
  input: { tenantId: string; name: string; email: string; successUrl: string; webhookUrl: string },
): Promise<string> {
  const { checkout_url } = Link.parse(
    await infinitepay(env, "/links", {
      handle: env.INFINITEPAY_HANDLE,
      items: [{ description: "Dish Desk · plano anual", price: BILLING_PLANS.annual.amountCents, quantity: 1 }],
      order_nsu: `${input.tenantId}.${Date.now()}`,
      redirect_url: input.successUrl,
      webhook: { url: input.webhookUrl, events: ["paid"] },
      customer: { name: input.name, email: input.email },
      options: { assured_installments: INTEREST_FREE_INSTALLMENTS, single_payment: true },
    }),
  );
  return checkout_url;
}

/** Restaurante do pagamento: o order_nsu é "<id do restaurante>.<instante do link>". */
export function tenantOfOrder(orderNsu: string): string | null {
  const tenantId = orderNsu.split(".")[0];
  return z.uuid().safeParse(tenantId).success ? tenantId! : null;
}

const PaymentCheck = z.looseObject({ success: z.boolean(), paid: z.boolean(), amount: z.number().optional() });

/**
 * O webhook da InfinitePay não é assinado: quem vale é esta consulta, que só responde paid quando o pagamento existe
 * na nossa conta com estes dados. Devolve o valor pago (sem os juros do parcelamento) ou null se não está pago.
 */
export async function paidAmount(env: Env, input: { orderNsu: string; transactionNsu: string; slug: string }): Promise<number | null> {
  const check = PaymentCheck.parse(
    await infinitepay(env, "/payment_check", {
      handle: env.INFINITEPAY_HANDLE,
      order_nsu: input.orderNsu,
      transaction_nsu: input.transactionNsu,
      slug: input.slug,
    }),
  );
  return check.success && check.paid ? (check.amount ?? null) : null;
}
