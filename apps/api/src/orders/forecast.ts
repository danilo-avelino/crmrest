import type { TenantTx } from "@dishdesk/database";
import { type AutomationMessages, automationMessagesOf, fillMessage, orderForecastOf } from "@dishdesk/shared";
import { Logger } from "@nestjs/common";
import { z } from "zod";
import type { JevClient, JevQuestion } from "../defense/jev.client.js";

/**
 * Base da previsão: os últimos pedidos do restaurante que saíram, dos últimos 14 dias. Saída marcada mais de 2 h depois
 * da confirmação é esquecimento (o restaurante marcou depois) e fica de fora. Com menos de MIN_SAMPLE, não há previsão.
 */
const SAMPLE = 60;
const SAMPLE_WINDOW_MS = 14 * 24 * 60 * 60_000;
const MIN_SAMPLE = 5;
const MAX_PREP_MS = 2 * 60 * 60_000;
/** Pedido que já passou de quase todos os tempos conhecidos: a previsão é agora + esta margem. */
const LATE_MARGIN_MS = 5 * 60_000;
/**
 * Pedido sem sair há mais que isto: a plataforma não avisou a saída (ex.: status não atualizado no Cardápio Web). Fica
 * sem previsão.
 */
export const STALE_MS = 4 * 60 * 60_000;
/**
 * Na fila "pedidos na sua frente", o pedido parado há mais que 2x o tempo de quase todos (p90), e no mínimo 45 min, é
 * saída que ninguém marcou: fica de fora.
 */
const QUEUE_STALE_MIN_MS = 45 * 60_000;
const EXITED = ["DISPATCHED", "DELIVERED", "CANCELED"] as const;
// Na cozinha: confirmado ou em preparo. O Cardápio Web não tem etapa de preparo (o confirmado já está sendo feito);
// o pedido ainda não aceito e o pronto, à espera do entregador ou da retirada, não entram na fila.
const IN_KITCHEN = ["CONFIRMED", "PREPARING"] as const;
/** Pedidos entregues da integração que dizem se o restaurante marca a saída nela. */
const TRACKING_SAMPLE = 20;

export type Forecast = {
  /** Previsão de saída do restaurante (nunca antes de agora, exceto em `probablyOut`). */
  departAt: Date;
  /**
   * Atrasado: a previsão passa do horário prometido ao cliente pela plataforma (iFood); sem promessa (ex.: Cardápio
   * Web), o pedido já passou do tempo normal de saída. A mensagem pede desculpas só quando atrasado.
   */
  late: boolean;
  /**
   * A integração do pedido não informa a saída (o restaurante vai de confirmado direto a concluído) e a previsão já
   * passou: o pedido provavelmente saiu. `departAt` é a previsão que passou.
   */
  probablyOut: boolean;
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

/** Quantil `q` (0 a 1), com interpolação entre os vizinhos. */
function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const position = q * (sorted.length - 1);
  const low = Math.floor(position);
  const high = Math.min(low + 1, sorted.length - 1);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (position - low);
}

/**
 * Que quantil dos tempos do restaurante prever. Calibrado em 11/11/2026 nos pedidos reais de todos os restaurantes
 * (previsão em cada pedido comparada com a saída de fato): a base 0,4 compensa o arredondamento para cima de 5 em 5
 * minutos; pedido de valor alto demora mais (`valueRank`: posição do valor dele entre os da base, de 0 a 1); o Jev
 * (`pace`, de 0 = bem mais rápido a 4 = bem mais demorado) pega o que os itens e a cozinha dizem. Erro médio: de 9,5
 * para 8,6 min só com o valor (2.267 previsões); numa amostra de 150 com o Jev, de 9,8 para 8,1 min.
 */
export function quantileFor(valueRank: number, pace: number | null): number {
  const q = 0.4 + 0.5 * (valueRank - 0.5) + 0.1 * ((pace ?? 2) - 2);
  return Math.min(0.9, Math.max(0.1, q));
}

/**
 * Previsão de saída (E26), a partir dos tempos "confirmado → saída" da base (SAMPLE). O pedido que já está na cozinha
 * há algum tempo é comparado só aos que demoraram mais que isso. O quantil vem de `quantileFor`, com o Jev quando `jev`
 * é passado (o cliente ou o atendente vai ler a previsão). Devolve null se o pedido já saiu, se é retirada e já ficou
 * pronto (não há saída), se está parado há mais de STALE_MS ou se ainda não há base.
 */
export async function forecastOrder(tx: TenantTx, orderId: string, now = new Date(), jev?: JevClient): Promise<Forecast | null> {
  const confirmed = { where: { code: "CONFIRMED" }, orderBy: { occurredAt: "asc" as const }, take: 1, select: { occurredAt: true } };
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      tenantId: true,
      channelId: true,
      status: true,
      placedAt: true,
      dispatchedAt: true,
      total: true,
      raw: true,
      events: confirmed,
      items: { select: { quantity: true, name: true } },
    },
  });
  if (!order || order.dispatchedAt || (EXITED as readonly string[]).includes(order.status)) return null;
  if (order.status === "READY" && isTakeout(order.raw)) return null;
  if (now.getTime() - order.placedAt.getTime() > STALE_MS) return null;

  const done = (
    await tx.order.findMany({
      where: {
        tenantId: order.tenantId,
        id: { not: order.id },
        dispatchedAt: { not: null, gte: new Date(now.getTime() - SAMPLE_WINDOW_MS), lte: now },
      },
      orderBy: { dispatchedAt: "desc" },
      take: SAMPLE,
      select: { placedAt: true, dispatchedAt: true, total: true, events: confirmed },
    })
  )
    .map((o) => ({ took: o.dispatchedAt!.getTime() - startOf(o), total: Number(o.total) }))
    .filter((o) => o.took > 0 && o.took <= MAX_PREP_MS);
  if (done.length < MIN_SAMPLE) return null;
  const durations = done.map((o) => o.took);

  const start = startOf(order);
  const elapsed = now.getTime() - start;
  const total = Number(order.total);
  // Empate (mesmo valor) conta meio: o pedido igual aos da base fica no meio.
  const valueRank = done.reduce((sum, o) => sum + (o.total < total ? 1 : o.total === total ? 0.5 : 0), 0) / done.length;
  const queueSince = new Date(now.getTime() - Math.max(2 * quantile(durations, 0.9), QUEUE_STALE_MIN_MS));
  const ahead = await tx.order.findMany({
    where: { tenantId: order.tenantId, placedAt: { gte: queueSince, lt: order.placedAt }, dispatchedAt: null, status: { in: [...IN_KITCHEN] } },
    orderBy: { placedAt: "asc" },
    select: { items: { select: { quantity: true, name: true } } },
  });

  const pace = jev?.enabled
    ? await paceOf(jev, order.id, order.tenantId, {
        tempos_do_restaurante: {
          pedidos_considerados: durations.length,
          um_em_quatro_sai_em_ate: asMinutes(quantile(durations, 0.25)),
          metade_sai_em_ate: asMinutes(quantile(durations, 0.5)),
          tres_em_quatro_saem_em_ate: asMinutes(quantile(durations, 0.75)),
          nove_em_dez_saem_em_ate: asMinutes(quantile(durations, 0.9)),
          valor_tipico_do_pedido: brl(quantile(done.map((o) => o.total), 0.5)),
        },
        este_pedido: {
          itens: order.items.slice(0, 15).map((item) => `${item.quantity}x ${item.name}`),
          valor: brl(total),
          tempo_desde_a_confirmacao: asMinutes(elapsed),
        },
        cozinha_agora: {
          pedidos_na_frente: ahead.length,
          itens_na_frente: ahead.slice(0, 8).flatMap((o) => o.items.slice(0, 4).map((item) => `${item.quantity}x ${item.name}`)),
          pedidos_que_sairam_na_ultima_meia_hora: await tx.order.count({
            where: { tenantId: order.tenantId, dispatchedAt: { gt: new Date(now.getTime() - 30 * 60_000), lte: now } },
          }),
        },
      })
    : null;
  const q = quantileFor(valueRank, pace);

  // Sem a saída marcada na integração, o pedido que passou da previsão provavelmente saiu: não há como saber.
  const usual = start + quantile(durations, q);
  if (now.getTime() >= usual && !(await tracksDispatch(tx, order.channelId, order.id))) {
    return { departAt: new Date(usual), late: false, probablyOut: true, ahead: 0 };
  }

  const longer = durations.filter((ms) => ms > elapsed);
  const departAt = Math.max(longer.length >= 3 ? start + quantile(longer, q) : now.getTime() + LATE_MARGIN_MS, now.getTime());
  const promised = promisedAt(order.raw);
  const late = promised ? departAt > promised.getTime() : elapsed >= quantile(durations, 0.5);
  return { departAt: new Date(departAt), late, probablyOut: false, ahead: ahead.length };
}

/** Se o restaurante marca a saída nesta integração: na maioria dos últimos pedidos entregues, a saída foi registrada. */
async function tracksDispatch(tx: TenantTx, channelId: string, orderId: string): Promise<boolean> {
  const delivered = await tx.order.findMany({
    where: { channelId, id: { not: orderId }, status: "DELIVERED" },
    orderBy: { placedAt: "desc" },
    take: TRACKING_SAMPLE,
    select: { dispatchedAt: true },
  });
  // Poucos pedidos: sem como saber; vale o normal, que é marcar a saída.
  return delivered.length < 3 || delivered.filter((o) => o.dispatchedAt).length * 2 >= delivered.length;
}

const asMinutes = (ms: number) => `${Math.round(ms / 60_000)} min`;
const brl = (value: number) => `R$ ${value.toFixed(2)}`;

const PACE_QUESTION = {
  pace: {
    type: "score",
    instructions:
      "Um restaurante de delivery prepara este pedido. Pelos itens (quantidade e o tipo de preparo), pelo valor comparado ao típico e pela cozinha agora (pedidos na frente e o ritmo de saídas), quanto tempo este pedido deve levar para sair, comparado aos tempos normais do restaurante?",
    criteria: [
      "Bem mais rápido que o normal do restaurante",
      "Um pouco mais rápido que o normal",
      "No tempo normal do restaurante",
      "Um pouco mais demorado que o normal",
      "Bem mais demorado que o normal",
    ],
  },
} satisfies Record<string, JevQuestion>;
/** O Jev responde em ~0,5 s; acima disto, a previsão segue sem ele. */
const PACE_TIMEOUT_MS = 3_000;
/** O cliente e o painel perguntam pelo mesmo pedido várias vezes seguidas: a avaliação do Jev vale por 5 minutos. */
const PACE_TTL_MS = 5 * 60_000;
const paceCache = new Map<string, { pace: number; at: number }>();
const logger = new Logger("Forecast");

/** A avaliação do Jev do ritmo deste pedido (0 a 4); null se ele falhar, recusar ou demorar. */
async function paceOf(jev: JevClient, orderId: string, tenantId: string, state: Record<string, unknown>): Promise<number | null> {
  const cached = paceCache.get(orderId);
  if (cached && Date.now() - cached.at < PACE_TTL_MS) return cached.pace;
  try {
    const { answers } = await jev.decide(tenantId, state, PACE_QUESTION, { privateData: true, timeoutMs: PACE_TIMEOUT_MS });
    if (answers.pace.type !== "score") return null;
    const pace = Math.min(4, Math.max(0, answers.pace.score));
    if (paceCache.size > 1000) paceCache.clear();
    paceCache.set(orderId, { pace, at: Date.now() });
    return pace;
  } catch (error) {
    logger.warn(`Previsão sem o Jev no pedido ${orderId}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
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
  if (forecast.probablyOut) return messages.forecastProbablyOut;
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
 * O que dizer ao cliente sobre o andamento do pedido: se já saiu para entrega, quando saiu; se é retirada e já ficou
 * pronto, que está pronto; se ainda está na cozinha, a previsão de saída. Null quando não há o que dizer (entregue,
 * cancelado ou sem base para a previsão).
 * `speakerSettings`: configurações do restaurante que fala com o cliente (personalidade e fila), quando o pedido é de
 * outro restaurante atendido pelo mesmo canal; sem elas, valem as do restaurante do pedido.
 * `jev`: ajusta a previsão pelos itens e pela cozinha (ver forecastOrder).
 */
export async function orderUpdateMessage(
  tx: TenantTx,
  orderId: string,
  now = new Date(),
  speakerSettings?: unknown,
  jev?: JevClient,
): Promise<{ kind: "dispatched" | "ready" | "forecast"; text: string } | null> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { status: true, dispatchedAt: true, displayCode: true, externalOrderId: true, raw: true, tenant: { select: { settings: true } } },
  });
  if (!order) return null;
  const settings = speakerSettings ?? order.tenant.settings;
  const messages = automationMessagesOf(settings);
  if (order.status === "DISPATCHED" && order.dispatchedAt) {
    return { kind: "dispatched", text: dispatchedMessage(order.dispatchedAt, messages, now) };
  }
  if (order.status === "READY" && isTakeout(order.raw)) {
    return { kind: "ready", text: readyNoticeMessage(order.displayCode ?? order.externalOrderId, messages) };
  }
  const forecast = await forecastOrder(tx, orderId, now, jev);
  if (!forecast) return null;
  return { kind: "forecast", text: forecastMessage(forecast, orderForecastOf(settings).showQueue, messages) };
}
