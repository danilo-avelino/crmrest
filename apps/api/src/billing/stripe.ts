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

const Url = z.object({ url: z.url() });

/** Assinaturas do cliente que ainda cobram (ativas ou com a cobrança pendente). */
async function subscriptionIds(env: Env, customerId: string): Promise<string[]> {
  const list = z
    .object({ data: z.array(z.object({ id: z.string() })) })
    .parse(await stripe(env, "GET", `/v1/subscriptions?customer=${encodeURIComponent(customerId)}`));
  return list.data.map((subscription) => subscription.id);
}

export async function hasSubscription(env: Env, customerId: string): Promise<boolean> {
  return (await subscriptionIds(env, customerId)).length > 0;
}

/**
 * Depois de um pagamento confirmado, cancela as outras assinaturas do cliente: a mensal de quem pagou o plano anual e
 * a antiga, ainda em cobrança (cartão recusado), de quem assinou de novo. keepId é a assinatura que acabou de ser paga.
 */
export async function cancelOtherSubscriptions(env: Env, customerId: string, keepId: string | null): Promise<void> {
  for (const id of await subscriptionIds(env, customerId)) {
    if (id !== keepId) await stripe(env, "DELETE", `/v1/subscriptions/${id}`);
  }
}

/**
 * Página de pagamento da Stripe (Checkout): assinatura mensal no cartão ou um ano em pagamento único, em qualquer meio
 * de pagamento ativo no painel da Stripe. O restaurante vai em client_reference_id e volta no webhook. Devolve o
 * endereço da página.
 */
export async function createCheckoutSession(
  env: Env,
  input: {
    plan: BillingPlanKey;
    tenantId: string;
    tenantName: string;
    taxId: string | null;
    customerId: string | null;
    email: string;
    successUrl: string;
    cancelUrl: string;
  },
): Promise<string> {
  const { amountCents } = BILLING_PLANS[input.plan];
  const price = "line_items[0][price_data]";
  const params = new URLSearchParams({
    mode: input.plan === "monthly" ? "subscription" : "payment",
    "line_items[0][quantity]": "1",
    [`${price}[currency]`]: "brl",
    [`${price}[unit_amount]`]: String(amountCents),
    [`${price}[product_data][name]`]: PLAN_NAME[input.plan],
    client_reference_id: input.tenantId,
    // Aparecem no pagamento, no painel da Stripe, para a emissão da nota fiscal.
    "metadata[restaurante]": input.tenantName,
    "metadata[cpf_cnpj]": input.taxId ?? "",
    locale: "pt-BR",
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  });
  if (input.plan === "monthly") {
    params.set(`${price}[recurring][interval]`, "month");
    // Só cartão: a renovação é debitada sozinha, sem o cliente ter de pagar cada mensalidade.
    params.set("payment_method_types[0]", "card");
  }
  if (input.customerId) params.set("customer", input.customerId);
  else params.set("customer_email", input.email);

  return Url.parse(await stripe(env, "POST", "/v1/checkout/sessions", params)).url;
}

/** Página da Stripe (Customer Portal) em que quem já assina o mensal troca o cartão das próximas cobranças. */
export async function createCardUpdateSession(env: Env, input: { customerId: string; returnUrl: string; doneUrl: string }): Promise<string> {
  const params = new URLSearchParams({
    customer: input.customerId,
    locale: "pt-BR",
    return_url: input.returnUrl,
    "flow_data[type]": "payment_method_update",
    "flow_data[after_completion][type]": "redirect",
    "flow_data[after_completion][redirect][return_url]": input.doneUrl,
  });
  return Url.parse(await stripe(env, "POST", "/v1/billing_portal/sessions", params)).url;
}
