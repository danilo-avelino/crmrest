import type { TenantTx } from "@dishdesk/database";
import { type AutomationMessages, automationMessagesOf, fillMessage, orderForecastOf } from "@dishdesk/shared";
import { z } from "zod";

/** Quantos pedidos que já saíram do restaurante formam a base da previsão. */
const SAMPLE = 10;
/** Pedido que já passou de todos os tempos conhecidos: a previsão é agora + esta margem. */
const LATE_MARGIN_MS = 10 * 60_000;
/**
 * Pedido sem sair há mais que isto: a plataforma não avisou a saída (ex.: status não atualizado no Cardápio Web). Fica
 * fora da previsão e da fila "pedidos na sua frente".
 */
export const STALE_MS = 4 * 60 * 60_000;
const EXITED = ["DISPATCHED", "DELIVERED", "CANCELED"] as const;
// Na cozinha: confirmado ou em preparo. O Cardápio Web não tem etapa de preparo (o confirmado já está sendo feito);
// o pedido ainda não aceito e o pronto, à espera do entregador ou da retirada, não entram na fila.
const IN_KITCHEN = ["CONFIRMED", "PREPARING"] as const;

export type Forecast = {
  /** Previsão de saída do restaurante (nunca antes de agora). */
  departAt: Date;
  /**
   * Atrasado: a previsão passa do horário prometido ao cliente pela plataforma (iFood); sem promessa (ex.: Cardápio
   * Web), o pedido já passou do tempo normal de saída. A mensagem pede desculpas só quando atrasado.
   */
  late: boolean;
  /**
   * Pedidos do restaurante na cozinha (IN_KITCHEN) feitos antes deste, de todas as integrações (iFood, Cardápio Web...).
   * Sem corte na meia-noite: o pedido das 23h55 ainda no forno conta para quem pede às 0h05.
   */
  ahead: number;
};

type Timed = { placedAt: Date; events: { occurredAt: Date }[] };

/** A contagem começa na confirmação; sem o evento (ex.: pedido lido já em outra etapa), na hora do pedido. */
function startOf(order: Timed): number {
  return (order.events[0]?.occurredAt ?? order.placedAt).getTime();
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * Previsão de saída (E26): mediana de "confirmado → saída" dos últimos pedidos do restaurante que já saíram. Se o
 * pedido já passou desse tempo, a previsão usa só os pedidos que demoraram mais que ele; se nenhum demorou tanto,
 * agora + margem. Devolve null se o pedido já saiu ou se ainda não há pedidos que saíram para servir de base.
 */
export async function forecastOrder(tx: TenantTx, orderId: string, now = new Date()): Promise<Forecast | null> {
  const confirmed = { where: { code: "CONFIRMED" }, orderBy: { occurredAt: "asc" as const }, take: 1, select: { occurredAt: true } };
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { id: true, tenantId: true, status: true, placedAt: true, dispatchedAt: true, raw: true, events: confirmed },
  });
  if (!order || order.dispatchedAt || (EXITED as readonly string[]).includes(order.status)) return null;
  if (now.getTime() - order.placedAt.getTime() > STALE_MS) return null;

  const done = await tx.order.findMany({
    where: { tenantId: order.tenantId, id: { not: order.id }, dispatchedAt: { not: null } },
    orderBy: { dispatchedAt: "desc" },
    take: SAMPLE,
    select: { placedAt: true, dispatchedAt: true, events: confirmed },
  });
  const durations = done.map((o) => o.dispatchedAt!.getTime() - startOf(o)).filter((ms) => ms > 0);
  if (!durations.length) return null;

  const start = startOf(order);
  const elapsed = now.getTime() - start;
  const typical = median(durations);
  const longer = durations.filter((ms) => ms > elapsed);
  const slow = typical <= elapsed;
  const departAt = Math.max(
    !slow ? start + typical : longer.length ? start + median(longer) : now.getTime() + LATE_MARGIN_MS,
    now.getTime(),
  );
  const promised = promisedAt(order.raw);
  const late = promised ? departAt > promised.getTime() : slow;

  const since = new Date(now.getTime() - STALE_MS);
  const ahead = await tx.order.count({
    where: {
      tenantId: order.tenantId,
      placedAt: { gte: since, lt: order.placedAt },
      dispatchedAt: null,
      status: { in: [...IN_KITCHEN] },
    },
  });
  return { departAt: new Date(departAt), late, ahead };
}

/** Campos do pedido da plataforma (guardado em `raw`): observações, horário prometido ao cliente e quem entrega (iFood). */
export const PlatformOrder = z.looseObject({
  // O iFood manda `extraInfo: null` quando não há observação: os campos aceitam null, senão o pedido inteiro não é lido.
  extraInfo: z.string().nullish(),
  orderType: z.string().nullish(),
  order_type: z.string().nullish(), // Cardápio Web
  delivery: z
    .looseObject({ deliveryDateTime: z.string().nullish(), observations: z.string().nullish(), deliveredBy: z.string().nullish() })
    .nullish(),
  takeout: z.looseObject({ takeoutDateTime: z.string().nullish() }).nullish(),
});

/** Entrega (ou retirada) prometida ao cliente pela plataforma; null se ela não informa. */
export function promisedAt(raw: unknown): Date | null {
  const order = PlatformOrder.safeParse(raw).data;
  const value = order?.delivery?.deliveryDateTime ?? order?.takeout?.takeoutDateTime;
  return value && !Number.isNaN(Date.parse(value)) ? new Date(value) : null;
}

/** O cliente busca o pedido na loja (iFood "TAKEOUT", Cardápio Web "takeout"): não há saída para entrega. */
export function isTakeout(raw: unknown): boolean {
  const order = PlatformOrder.safeParse(raw).data;
  return (order?.orderType ?? order?.order_type)?.toUpperCase() === "TAKEOUT";
}

const CLOCK = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
const FIVE_MINUTES = 5 * 60_000;

/** Mensagem ao cliente, no tom da personalidade; o horário sobe para o próximo múltiplo de 5 minutos ("por volta das 19:45"). */
export function forecastMessage(forecast: Forecast, showQueue: boolean, messages: AutomationMessages): string {
  const hora = CLOCK.format(new Date(Math.ceil(forecast.departAt.getTime() / FIVE_MINUTES) * FIVE_MINUTES));
  const lines = [fillMessage(forecast.late ? messages.forecastLate : messages.forecast, { hora })];
  if (showQueue && forecast.ahead > 0) {
    lines.push(forecast.ahead === 1 ? messages.queueOne : fillMessage(messages.queueMany, { quantidade: forecast.ahead }));
  }
  return lines.join("\n");
}

/** Pedido que já saiu: "🛵 Seu pedido já saiu para entrega às 19:23 (13 minutos atrás)." */
export function dispatchedMessage(dispatchedAt: Date, messages: AutomationMessages, now = new Date()): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - dispatchedAt.getTime()) / 60_000));
  const ago =
    minutes < 1
      ? "agora há pouco"
      : minutes < 60
        ? `${minutes} ${minutes === 1 ? "minuto" : "minutos"} atrás`
        : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min atrás`;
  return fillMessage(messages.dispatched, { hora: CLOCK.format(dispatchedAt), tempo: ago });
}

/** Aviso na hora em que o pedido fica pronto: "✅ Seu pedido #95 ficou pronto!" */
export function readyNoticeMessage(code: string, messages: AutomationMessages): string {
  return fillMessage(messages.readyNotice, { pedido: code });
}

/** Aviso na hora em que o pedido sai: "🛵 Boa notícia! Seu pedido #95 saiu para entrega às 19:23." */
export function dispatchNoticeMessage(code: string, dispatchedAt: Date, messages: AutomationMessages): string {
  return fillMessage(messages.dispatchNotice, { pedido: code, hora: CLOCK.format(dispatchedAt) });
}

/** Aviso na hora em que o pedido é entregue: "✅ Seu pedido #95 foi entregue! Bom apetite 😋" */
export function deliveredNoticeMessage(code: string, messages: AutomationMessages): string {
  return fillMessage(messages.deliveredNotice, { pedido: code });
}

/**
 * O que dizer ao cliente sobre o andamento do pedido: se já saiu para entrega, quando saiu; se ainda está na cozinha,
 * a previsão de saída. Null quando não há o que dizer (entregue, cancelado ou sem base para a previsão).
 */
export async function orderUpdateMessage(
  tx: TenantTx,
  orderId: string,
  now = new Date(),
): Promise<{ kind: "dispatched" | "forecast"; text: string } | null> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { status: true, dispatchedAt: true, tenant: { select: { settings: true } } },
  });
  if (!order) return null;
  const messages = automationMessagesOf(order.tenant.settings);
  if (order.status === "DISPATCHED" && order.dispatchedAt) {
    return { kind: "dispatched", text: dispatchedMessage(order.dispatchedAt, messages, now) };
  }
  const forecast = await forecastOrder(tx, orderId, now);
  if (!forecast) return null;
  return { kind: "forecast", text: forecastMessage(forecast, orderForecastOf(order.tenant.settings).showQueue, messages) };
}
