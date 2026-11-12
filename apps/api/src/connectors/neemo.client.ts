import type { OrderStatus } from "@dishdesk/database/enums";
import { z } from "zod";
import type { Env } from "../config/env.js";

// API de integração da Neemo (Linx Delivery App), documentada no Swagger público em
// https://deliveryapp.neemo.com.br/api/docs/?integration=true. Autenticação pelo token da loja (`token_account`, gerado
// no painel da Neemo em Configurações → Integração), mandado como campo de formulário em todo request. Sem webhook de
// pedido novo: o Dish Desk lê os pedidos alterados (polling). As respostas de sucesso vêm com HTTP 201.

const Id = z.coerce.string();
const Money = z.coerce.number();
const Text = z.string().nullish();

/** Pedido como vem na lista: com o cliente e o endereço, sem os itens. */
export const NeemoOrderSummary = z.looseObject({
  id: Id,
  status: z.coerce.number(),
  /** "2026-11-12T13:07:27-03:00" */
  date: z.string(),
  updated_at: z.string(),
});
export type NeemoOrderSummary = z.infer<typeof NeemoOrderSummary>;

const NeemoComplement = z.looseObject({ quantity: Money.default(1), title: z.string() });

export const NeemoOrder = z.looseObject({
  id: Id,
  restaurant_id: Id.nullish(),
  order_number: Id.nullish(),
  status: z.coerce.number(),
  date: z.string(),
  updated_at: z.string(),
  name: Text,
  /** Telefone com o DDD ("86999999999"). */
  phone: Text,
  email: Text,
  cpf: Text,
  client_id: Id.nullish(),
  street: Text,
  number: Text,
  complement: Text,
  reference_point: Text,
  neighborhood: Text,
  city: Text,
  uf: Text,
  cep: Text,
  /** 1 = entrega, 2 = retirada. */
  forma_entrega: z.coerce.number().nullish(),
  tax: Money.default(0),
  sub_total: Money.default(0),
  total: Money,
  // `total` é o da linha (quantidade × preço, com os complementos).
  ItemOrder: z
    .array(
      z.looseObject({
        name: Text,
        title: Text,
        quantity: Money.default(1),
        total: Money.default(0),
        notes: Text,
        ComplementCategories: z.array(z.looseObject({ Complements: z.array(NeemoComplement).default([]) })).default([]),
      }),
    )
    .default([]),
  // Pizzas e combos vêm em listas próprias; a loja de teste não tinha nenhum, então só o básico é lido.
  PizzaOrders: z.array(z.looseObject({ title: Text, name: Text, quantity: Money.default(1), total: Money.default(0) })).nullish(),
  ComboOrders: z.array(z.looseObject({ title: Text, name: Text, quantity: Money.default(1), total: Money.default(0) })).nullish(),
});
export type NeemoOrder = z.infer<typeof NeemoOrder>;

/** Cliente da base da loja. O telefone vem sem o DDD, que vem à parte. */
export const NeemoCustomer = z.looseObject({ id: Id, name: Text, email: Text, ddd: Text, phone: Text, cpf: Text });
export type NeemoCustomer = z.infer<typeof NeemoCustomer>;

/**
 * Status da Neemo: 0 novo, 1 confirmado, 2 entregue, 3 cancelado pelo restaurante, 4 enviado, 5 cancelado
 * automaticamente, 6 cancelado com estorno (restaurante), 7 cancelado automaticamente com estorno.
 */
const CANCELED_BY_STORE = 3;
export const NEEMO_CANCELED = [3, 5, 6, 7];

/** Status da Neemo → status do pedido no Dish Desk. */
export const NEEMO_STATUS: Record<number, OrderStatus> = {
  0: "PLACED",
  1: "CONFIRMED",
  2: "DELIVERED",
  3: "CANCELED",
  4: "DISPATCHED",
  5: "CANCELED",
  6: "CANCELED",
  7: "CANCELED",
};

/** Status da Neemo → etapa na linha do tempo do pedido, com os códigos dos eventos do iFood. */
export const NEEMO_EVENT: Record<number, string> = {
  0: "PLACED",
  1: "CONFIRMED",
  2: "DELIVERED",
  3: "CANCELLED",
  4: "DISPATCHED",
  5: "CANCELLED",
  6: "CANCELLED",
  7: "CANCELLED",
};

/** Retirada na loja (forma_entrega 2): não há saída para entrega. */
export const NEEMO_TAKEOUT = 2;

/** Máximo de pedidos por página na API. */
export const NEEMO_ORDERS_PAGE = 50;
/** Máximo de clientes por página na API. */
export const NEEMO_CUSTOMERS_PAGE = 500;

const SAO_PAULO = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "America/Sao_Paulo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** Os filtros de data da API são no horário de Brasília, sem fuso: "2026-11-12 13:07:27". */
export function neemoTime(date: Date): string {
  return SAO_PAULO.format(date);
}

export class NeemoClient {
  constructor(private readonly env: Pick<Env, "NEEMO_API_URL">) {}

  get configured(): boolean {
    return Boolean(this.env.NEEMO_API_URL);
  }

  /**
   * Uma página de pedidos (até 50), com o total para paginar. `modified`: criados ou alterados desde a data;
   * `status`: só os desse status.
   */
  async orders(
    token: string,
    query: { modified?: Date; status?: number; page?: number; limit?: number; sort?: string },
  ): Promise<{ orders: NeemoOrderSummary[]; total: number; store: string | null }> {
    const body = await this.call(token, "POST", "/v1/order", {
      limit: String(query.limit ?? NEEMO_ORDERS_PAGE),
      page: String(query.page ?? 1),
      ...(query.modified && { modified: neemoTime(query.modified) }),
      ...(query.status !== undefined && { status: String(query.status) }),
      ...(query.sort && { sort: query.sort }),
    });
    const page = z
      .looseObject({ name: z.string().nullish(), Orders: z.array(NeemoOrderSummary).default([]), paging: z.looseObject({ total: z.coerce.number() }).nullish() })
      .parse(body);
    return { orders: page.Orders, total: page.paging?.total ?? page.Orders.length, store: page.name?.trim() || null };
  }

  async order(token: string, orderId: string): Promise<NeemoOrder> {
    const body = await this.call(token, "POST", `/v1/order/${encodeURIComponent(orderId)}`);
    return z.looseObject({ Order: NeemoOrder }).parse(body).Order;
  }

  /** Uma página (até 500) da base de clientes da loja; a API não diz o total: a página incompleta é a última. */
  async customers(token: string, page: number): Promise<NeemoCustomer[]> {
    const body = await this.call(token, "POST", "/v1/client", { limit: String(NEEMO_CUSTOMERS_PAGE), page: String(page), sort: "id asc" });
    return z.looseObject({ Clients: z.array(NeemoCustomer).default([]) }).parse(body).Clients;
  }

  /** Cancela o pedido na loja (status 3, "cancelado pelo restaurante"). A API não recebe o motivo. Não dá para desfazer. */
  async cancel(token: string, orderId: string): Promise<void> {
    await this.call(token, "PUT", `/v1/order/${encodeURIComponent(orderId)}`, { status: String(CANCELED_BY_STORE) });
  }

  private async call(token: string, method: "POST" | "PUT", path: string, form: Record<string, string> = {}): Promise<unknown> {
    const response = await fetch(`${this.env.NEEMO_API_URL}${path}`, {
      method,
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token_account: token, ...form }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    // Token recusado: HTTP 401 (a tela de conexão traduz como "a credencial não foi aceita").
    if (!response.ok) throw new Error(`Neemo ${path}: HTTP ${response.status}`);
    return response.json();
  }
}
