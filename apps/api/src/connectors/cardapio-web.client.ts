import type { OrderStatus } from "@dishdesk/database/enums";
import { z } from "zod";
import type { Env } from "../config/env.js";

// API de parceiros do Cardápio Web (docs.cardapioweb.com): polling dos pedidos alterados, detalhes do pedido e base de clientes.
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

/** Cliente da base do restaurante. Data de nascimento inválida vira null em vez de recusar a página inteira. */
export const CardapioWebCustomer = z.looseObject({
  id: Id,
  name: z.string().nullish(),
  email: z.string().nullish(),
  phone_number: z.string().nullish(),
  ddi: z.string().nullish(),
  birth_date: z.iso.date().nullish().catch(null),
  created_at: z.string(),
  notifications_enabled: z.boolean().nullish(),
});
export type CardapioWebCustomer = z.infer<typeof CardapioWebCustomer>;

const CardapioWebCustomersPage = z.looseObject({
  customers: z.array(CardapioWebCustomer),
  pagination: z.looseObject({ current_page: z.number(), total_pages: z.number(), total_customers: z.number() }),
});
export type CardapioWebCustomersPage = z.infer<typeof CardapioWebCustomersPage>;

/** Status do Cardápio Web → status do pedido no Dish Desk. Os demais (ex.: "canceling") não mudam o pedido. */
export const CARDAPIO_WEB_STATUS: Record<string, OrderStatus> = {
  waiting_confirmation: "PLACED",
  pending_payment: "PLACED",
  pending_online_payment: "PLACED",
  scheduled_confirmed: "CONFIRMED",
  confirmed: "CONFIRMED",
  ready: "READY",
  waiting_to_catch: "READY",
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

  /** Uma página (50 clientes, o máximo da API) da base de clientes da loja. */
  async customers(apiKey: string, page: number): Promise<CardapioWebCustomersPage> {
    const response = await this.call(apiKey, `/api/partner/v1/merchant/customers?page=${page}&per_page=50`);
    return CardapioWebCustomersPage.parse(await response.json());
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
