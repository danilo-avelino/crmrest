import { createHmac, timingSafeEqual } from "node:crypto";
import { BILLING_PLANS, type BillingPlanKey } from "@dishdesk/shared";
import { z } from "zod";
import type { Env } from "../config/env.js";

const PLAN_NAME = { monthly: "Dish Desk · plano mensal", annual: "Dish Desk · plano anual" } as const;
const SIGNATURE_TOLERANCE_S = 5 * 60;

/** Valida o Stripe-Signature ("t=<segundos>,v1=<hmac>"): HMAC-SHA256 de "<t>.<corpo bruto>" com o segredo do endpoint. */
export function verifyStripeSignature(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  const parts = (header ?? "").split(",").map((part) => part.split("="));
  const timestamp = parts.find(([key]) => key === "t")?.[1];
  // Evento antigo não vale: quem capturou uma requisição não consegue reenviá-la depois.
  if (!timestamp || !(Math.abs(Date.now() / 1000 - Number(timestamp)) <= SIGNATURE_TOLERANCE_S)) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex");
  return parts.some(
    ([key, value]) =>
      key === "v1" && value?.length === expected.length && timingSafeEqual(Buffer.from(value), Buffer.from(expected)),
  );
}

async function stripe(env: Env, method: string, path: string, body?: URLSearchParams): Promise<unknown> {
  const response = await fetch(`${env.STRIPE_API_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Stripe ${method} ${path}: HTTP ${response.status} ${await response.text()}`);
  return response.json();
}

/**
 * Página de pagamento da Stripe (Checkout) para um restaurante bloqueado: assinatura mensal no cartão ou um ano no Pix.
 * O restaurante vai em client_reference_id e volta no webhook. Devolve o endereço da página.
 */
export async function createCheckoutSession(
  env: Env,
  input: { plan: BillingPlanKey; tenantId: string; tenantName: string; taxId: string | null; customerId: string | null; email: string },
): Promise<string> {
  // Uma assinatura antiga ainda em cobrança (cartão recusado) cobraria de novo depois do pagamento novo.
  if (input.customerId) {
    const open = z
      .object({ data: z.array(z.object({ id: z.string() })) })
      .parse(await stripe(env, "GET", `/v1/subscriptions?customer=${encodeURIComponent(input.customerId)}`));
    for (const subscription of open.data) await stripe(env, "DELETE", `/v1/subscriptions/${subscription.id}`);
  }

  const { amountCents, method } = BILLING_PLANS[input.plan];
  const price = "line_items[0][price_data]";
  const page = `${env.WEB_ORIGIN}/assinatura?restaurante=${input.tenantId}`;
  const params = new URLSearchParams({
    mode: input.plan === "monthly" ? "subscription" : "payment",
    "payment_method_types[0]": method,
    "line_items[0][quantity]": "1",
    [`${price}[currency]`]: "brl",
    [`${price}[unit_amount]`]: String(amountCents),
    [`${price}[product_data][name]`]: PLAN_NAME[input.plan],
    client_reference_id: input.tenantId,
    // Aparecem no pagamento, no painel da Stripe, para a emissão da nota fiscal.
    "metadata[restaurante]": input.tenantName,
    "metadata[cpf_cnpj]": input.taxId ?? "",
    locale: "pt-BR",
    success_url: `${page}&pago=1`,
    cancel_url: page,
  });
  if (input.plan === "monthly") params.set(`${price}[recurring][interval]`, "month");
  if (input.customerId) params.set("customer", input.customerId);
  else params.set("customer_email", input.email);

  return z.object({ url: z.url() }).parse(await stripe(env, "POST", "/v1/checkout/sessions", params)).url;
}
