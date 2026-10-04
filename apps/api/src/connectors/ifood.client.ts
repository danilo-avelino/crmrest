import type { OrderStatus } from "@comanda/database/enums";
import { z } from "zod";
import type { Env } from "../config/env.js";

// Merchant API do iFood: autenticação, polling de eventos, detalhes do pedido e confirmação (ack).

export const IfoodEvent = z.looseObject({
  id: z.string(),
  fullCode: z.string(),
  orderId: z.string(),
  merchantId: z.string(),
  createdAt: z.string(),
});
export type IfoodEvent = z.infer<typeof IfoodEvent>;

const Money = z.coerce.number();

export const IfoodOrder = z.looseObject({
  id: z.string(),
  displayId: z.string().optional(),
  createdAt: z.string(),
  customer: z.looseObject({
    id: z.string(),
    name: z.string().optional(),
    documentNumber: z.string().optional(),
  }),
  items: z
    .array(z.looseObject({ name: z.string(), quantity: z.coerce.number(), unitPrice: Money, observations: z.string().optional() }))
    .default([]),
  total: z.looseObject({ subTotal: Money, deliveryFee: Money.default(0), orderAmount: Money }),
  delivery: z
    .looseObject({
      deliveryAddress: z
        .looseObject({
          streetName: z.string(),
          streetNumber: z.string().optional(),
          complement: z.string().optional(),
          neighborhood: z.string().optional(),
          city: z.string(),
          state: z.string(),
          postalCode: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});
export type IfoodOrder = z.infer<typeof IfoodOrder>;

/** Eventos de status (fullCode) → status do pedido no Comanda. Os demais são só confirmados. */
export const IFOOD_STATUS: Record<string, OrderStatus> = {
  PLACED: "PLACED",
  CONFIRMED: "CONFIRMED",
  PREPARATION_STARTED: "PREPARING",
  READY_TO_PICKUP: "PREPARING",
  DISPATCHED: "DISPATCHED",
  CONCLUDED: "DELIVERED",
  CANCELLED: "CANCELED",
};

export class IfoodClient {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly env: Pick<Env, "IFOOD_API_URL" | "IFOOD_CLIENT_ID" | "IFOOD_CLIENT_SECRET">) {}

  get configured(): boolean {
    return Boolean(this.env.IFOOD_CLIENT_ID && this.env.IFOOD_CLIENT_SECRET);
  }

  /** Eventos ainda não confirmados das lojas informadas (o iFood guarda até a confirmação). */
  async poll(merchantIds: string[]): Promise<IfoodEvent[]> {
    const response = await this.call("/order/v1.0/events:polling", { headers: { "x-polling-merchants": merchantIds.join(",") } });
    if (response.status === 204) return [];
    return z.array(IfoodEvent).parse(await response.json());
  }

  async order(orderId: string): Promise<IfoodOrder> {
    const response = await this.call(`/order/v1.0/orders/${orderId}`);
    return IfoodOrder.parse(await response.json());
  }

  /** Só eventos processados com sucesso são confirmados (os demais voltam no próximo polling). */
  async acknowledge(eventIds: string[]): Promise<void> {
    if (!eventIds.length) return;
    await this.call("/order/v1.0/events/acknowledgment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(eventIds.map((id) => ({ id }))),
    });
  }

  private async call(path: string, init: Omit<RequestInit, "headers"> & { headers?: Record<string, string> } = {}): Promise<Response> {
    const response = await fetch(`${this.env.IFOOD_API_URL}${path}`, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${await this.accessToken()}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401) this.token = null; // renova na próxima chamada
    if (!response.ok) throw new Error(`iFood ${path}: HTTP ${response.status}`);
    return response;
  }

  /** OAuth client credentials, reaproveitado até 1 min antes de expirar. */
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const response = await fetch(`${this.env.IFOOD_API_URL}/authentication/v1.0/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grantType: "client_credentials",
        clientId: this.env.IFOOD_CLIENT_ID ?? "",
        clientSecret: this.env.IFOOD_CLIENT_SECRET ?? "",
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`iFood autenticação: HTTP ${response.status}`);
    const body = z.object({ accessToken: z.string(), expiresIn: z.coerce.number() }).parse(await response.json());
    this.token = { value: body.accessToken, expiresAt: Date.now() + body.expiresIn * 1000 };
    return body.accessToken;
  }
}
