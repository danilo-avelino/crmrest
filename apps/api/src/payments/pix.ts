import { z } from "zod";
import type { Env } from "../config/env.js";

// Pix do cardápio (F6). PixProvider é a interface; a primeira implementação é a Pagar.me no modelo marketplace: a conta
// de plataforma do Dish Desk cria a cobrança e o split manda 100% ao recebedor do restaurante (a conta bancária que ele
// escolheu). O Dish Desk nunca recebe o dinheiro. Formato conferido pela documentação da API v5 (Orders + Pix + split);
// validar com as chaves de teste quando a conta de plataforma for liberada.

export type PixCharge = {
  providerOrderId: string;
  chargeId: string | null;
  qrCode: string; // "copia e cola"
  qrCodeUrl: string | null; // imagem do QR
  expiresAt: Date;
  status: PixStatus;
};
export type PixStatus = "PENDING" | "PAID" | "EXPIRED" | "CANCELED";

export type CreatePixInput = {
  reference: string; // nosso id do pagamento (idempotência e conferência)
  amountCents: number;
  description: string;
  expiresInSeconds: number;
  recipientId: string;
  customer: { name: string; phoneE164: string; cpf: string; email?: string | null };
};

export interface PixProvider {
  readonly name: string;
  readonly configured: boolean;
  createCharge(input: CreatePixInput): Promise<PixCharge>;
  /** Situação na fonte (o webhook só avisa; quem decide é esta consulta). */
  status(providerOrderId: string): Promise<PixStatus>;
}

export class PixProviderError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const Transaction = z.looseObject({ qr_code: z.string().optional(), qr_code_url: z.string().nullish(), expires_at: z.string().optional() });
const Charge = z.looseObject({ id: z.string().optional(), status: z.string().optional(), last_transaction: Transaction.nullish() });
const Order = z.looseObject({ id: z.string(), status: z.string(), charges: z.array(Charge).default([]) });

/** Situação da Pagar.me -> a nossa. "paid" pago; "canceled"/"failed" cancelado; o resto, pendente. */
export function pagarmeStatus(order: { status: string; charges?: { status?: string }[] }): PixStatus {
  const charge = order.charges?.[0]?.status;
  if (order.status === "paid" || charge === "paid") return "PAID";
  if (order.status === "canceled" || order.status === "failed" || charge === "canceled" || charge === "failed") return "CANCELED";
  return "PENDING";
}

const phoneParts = (e164: string) => {
  const digits = e164.replace(/\D/g, "").replace(/^55/, "");
  return { country_code: "55", area_code: digits.slice(0, 2), number: digits.slice(2) };
};

export class PagarmePixProvider implements PixProvider {
  readonly name = "pagarme";

  constructor(private readonly env: Pick<Env, "PAGARME_SECRET_KEY" | "PAGARME_API_URL">) {}

  get configured(): boolean {
    return Boolean(this.env.PAGARME_SECRET_KEY);
  }

  async createCharge(input: CreatePixInput): Promise<PixCharge> {
    const body = {
      code: input.reference,
      items: [{ amount: input.amountCents, description: input.description.slice(0, 250), quantity: 1, code: input.reference }],
      customer: {
        name: input.customer.name.slice(0, 64),
        type: "individual",
        document: input.customer.cpf,
        document_type: "CPF",
        ...(input.customer.email ? { email: input.customer.email } : {}),
        phones: { mobile_phone: phoneParts(input.customer.phoneE164) },
      },
      payments: [
        {
          payment_method: "pix",
          pix: { expires_in: input.expiresInSeconds },
          split: [
            {
              amount: 100,
              type: "percentage",
              recipient_id: input.recipientId,
              options: { charge_processing_fee: true, charge_remainder_fee: true, liable: true },
            },
          ],
        },
      ],
    };
    const order = Order.parse(await this.call("/orders", { method: "POST", body: JSON.stringify(body), headers: { "Idempotency-Key": input.reference } }));
    const charge = order.charges[0];
    const tx = charge?.last_transaction;
    if (!tx?.qr_code) throw new PixProviderError(502, "A Pagar.me não devolveu o código do Pix.");
    return {
      providerOrderId: order.id,
      chargeId: charge?.id ?? null,
      qrCode: tx.qr_code,
      qrCodeUrl: tx.qr_code_url ?? null,
      expiresAt: tx.expires_at ? new Date(tx.expires_at) : new Date(Date.now() + input.expiresInSeconds * 1000),
      status: pagarmeStatus(order),
    };
  }

  async status(providerOrderId: string): Promise<PixStatus> {
    const order = Order.parse(await this.call(`/orders/${encodeURIComponent(providerOrderId)}`));
    return pagarmeStatus(order);
  }

  private async call(path: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}): Promise<unknown> {
    if (!this.env.PAGARME_SECRET_KEY) throw new PixProviderError(503, "O Pix não está configurado (falta a chave da Pagar.me).");
    const response = await fetch(`${this.env.PAGARME_API_URL}${path}`, {
      method: init.method ?? "GET",
      body: init.body,
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.env.PAGARME_SECRET_KEY}:`).toString("base64")}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new PixProviderError(response.status, `A Pagar.me recusou (${response.status}).`);
    return response.json();
  }
}
