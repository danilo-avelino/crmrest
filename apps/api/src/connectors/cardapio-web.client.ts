import type { OrderStatus } from "@comanda/database/enums";
import { z } from "zod";
import type { Env } from "../config/env.js";

// API de parceiros do Cardápio Web (docs.cardapioweb.com): polling dos pedidos alterados e detalhes do pedido.
// Autenticação pela chave da loja (X-API-KEY, gerada no Portal em Configurações → Integrações → API).

const Id = z.coerce.string();
const Money = z.coerce.number();

export const CardapioWebOrderSummary = z.looseObject({
  id: Id,
  status: z.string(),
  sales_channel: z.string().optional(),
  updated_at: z.string(),
});
export type CardapioWebOrderSummary = z.infer<typeof CardapioWebOrderSummary>;

export const CardapioWebOrder = z.looseObject({
  id: Id,
  display_id: Id.nullish(),
  status: z.string(),
  created_at: z.string(),
  fiscal_document: z.string().nullish(),
  customer: z
    .looseObject({ id: Id.nullish(), name: z.string().nullish(), phone: z.string().nullish(), ddi: z.string().nullish() })
    .nullish(),
  delivery_address: z
    .looseObject({
      street: z.string(),
      number: z.string().nullish(),
      complement: z.string().nullish(),
      neighborhood: z.string().nullish(),
      city: z.string(),
      state: z.string(),
      postal_code: z.string().nullish(),
    })
    .nullish(),
  // total_price já inclui os adicionais (options) do item.
  items: z
    .array(z.looseObject({ name: z.string(), quantity: Money, total_price: Money, observation: z.string().nullish() }))
    .default([]),
  delivery_fee: Money.default(0),
  total: Money,
});
export type CardapioWebOrder = z.infer<typeof CardapioWebOrder>;

/** Status do Cardápio Web → status do pedido no Comanda. Os demais (ex.: "canceling") não mudam o pedido. */
export const CARDAPIO_WEB_STATUS: Record<string, OrderStatus> = {
  waiting_confirmation: "PLACED",
  pending_payment: "PLACED",
  pending_online_payment: "PLACED",
  scheduled_confirmed: "CONFIRMED",
  confirmed: "CONFIRMED",
  ready: "PREPARING",
  waiting_to_catch: "PREPARING",
  released: "DISPATCHED",
  delivered: "DELIVERED",
  closed: "DELIVERED",
  canceled: "CANCELED",
};

export class CardapioWebClient {
  constructor(private readonly env: Pick<Env, "CARDAPIO_WEB_API_URL">) {}

  get configured(): boolean {
    return Boolean(this.env.CARDAPIO_WEB_API_URL);
  }

  /** Pedidos criados ou alterados desde `since` (sem confirmação: a consulta pode se repetir). */
  async updatedOrders(apiKey: string, since: Date): Promise<CardapioWebOrderSummary[]> {
    const response = await this.call(apiKey, `/api/partner/v1/orders?updated_since=${encodeURIComponent(since.toISOString())}`);
    return z.array(CardapioWebOrderSummary).parse(await response.json());
  }

  async order(apiKey: string, orderId: string): Promise<CardapioWebOrder> {
    const response = await this.call(apiKey, `/api/partner/v1/orders/${encodeURIComponent(orderId)}`);
    return CardapioWebOrder.parse(await response.json());
  }

  private async call(apiKey: string, path: string): Promise<Response> {
    const response = await fetch(`${this.env.CARDAPIO_WEB_API_URL}${path}`, {
      headers: { "X-API-KEY": apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Cardápio Web ${path.split("?")[0]}: HTTP ${response.status}`);
    return response;
  }
}
