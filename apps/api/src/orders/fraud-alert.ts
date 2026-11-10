import type { Prisma, TenantTx } from "@dishdesk/database";
import type { ChannelType, OrderStatus } from "@dishdesk/database/enums";
import { type CanceledOrderRow, type CustomerCancellations, FRAUD_RULES, type OrderAlertDecision, type OrderAlertDto } from "@dishdesk/shared";
import { z } from "zod";
import { startOfYesterday } from "../automations/automation.js";
import { addressBase, addressKey, addressText } from "./address-key.js";
import { linkedOrdersWhere, provenPhone, provenPhoneWhere } from "./customer-history.js";

type ContactKeys = { id: string; phone: string | null; phoneSource: string | null; cpfHash: string | null; email: string | null };

/** Pedido ainda em andamento: é o que recebe o alerta. */
export const ACTIVE_ORDER: OrderStatus[] = ["PLACED", "CONFIRMED", "PREPARING", "READY", "DISPATCHED"];

/** A lista do alerta não precisa de mais que isso: o atendente decide pelos mais recentes. */
const MAX_ROWS = 100;
/** Endereços parecidos que o Jev compara por pedido. */
const MAX_SIMILAR = 3;

const rowInclude = {
  channel: { select: { type: true } },
  tenant: { select: { name: true } },
  fraudMarkedBy: { select: { name: true } },
  events: { where: { code: "CANCELLED" }, select: { code: true, metadata: true } },
} satisfies Prisma.OrderInclude;

type RowOrder = Prisma.OrderGetPayload<{ include: typeof rowInclude }>;

/** `CANCEL_ORIGIN` do evento de cancelamento do iFood. SCHEDULER: a loja não confirmou o pedido a tempo. */
const STORE_ORIGINS = new Set(["RESTAURANT", "MERCHANT", "SCHEDULER"]);
const CUSTOMER_ORIGINS = new Set(["CONSUMER", "CUSTOMER"]);
const CancelMetadata = z.looseObject({ CANCEL_ORIGIN: z.string() });

/** Quem cancelou. O Cardápio Web e o histórico importado não informam: null. */
function canceledBy(order: RowOrder): CanceledOrderRow["canceledBy"] {
  if (order.alertDecision === "CANCELED") return "team";
  const metadata = CancelMetadata.safeParse(order.events.find((event) => event.code === "CANCELLED")?.metadata).data;
  if (!metadata) return null;
  const origin = metadata.CANCEL_ORIGIN.toUpperCase();
  return STORE_ORIGINS.has(origin) ? "store" : CUSTOMER_ORIGINS.has(origin) ? "customer" : origin === "IFOOD" ? "platform" : null;
}

export function toCanceledRow(order: RowOrder, showRestaurant = false): CanceledOrderRow {
  const by = canceledBy(order);
  const afterDispatch = order.deliveredAt !== null || (order.dispatchedAt !== null && order.canceledAt !== null && order.canceledAt >= order.dispatchedAt);
  return {
    id: order.id,
    displayCode: order.displayCode,
    channelType: order.channel.type,
    restaurantName: showRestaurant ? order.tenant.name : null,
    total: order.total.toFixed(2),
    placedAt: order.placedAt.toISOString(),
    reason: order.cancellationReason,
    imported: order.importedAt !== null,
    fraud: order.fraudMarkedAt && { by: order.fraudMarkedBy?.name ?? null, at: order.fraudMarkedAt.toISOString() },
    address: addressText(order.deliveryAddress),
    canceledBy: by,
    afterDispatch,
    // Falta de item ou loja fechada não diz nada do cliente; o que já tinha saído para a entrega, sim.
    counted: order.fraudMarkedAt !== null || by !== "store" || afterDispatch,
  };
}

/** Os cancelamentos do cliente em todas as fontes ligadas a ele (mesmo telefone, CPF ou e-mail). */
export async function customerCancellations(tx: TenantTx, contact: ContactKeys): Promise<CustomerCancellations> {
  const linked = linkedOrdersWhere(contact);
  const where: Prisma.OrderWhereInput = { AND: [linked, { status: "CANCELED" }] };
  const [ordersCount, canceledCount, rows] = await Promise.all([
    tx.order.count({ where: linked }),
    tx.order.count({ where }),
    tx.order.findMany({ where, include: rowInclude, orderBy: [{ placedAt: "desc" }, { id: "desc" }], take: MAX_ROWS }),
  ]);
  return summarize(ordersCount, canceledCount, rows);
}

function summarize(ordersCount: number, canceledCount: number, orders: RowOrder[]): CustomerCancellations {
  const showRestaurant = new Set(orders.map((order) => order.tenantId)).size > 1;
  const bySource = new Map<ChannelType, number>();
  for (const order of orders) bySource.set(order.channel.type, (bySource.get(order.channel.type) ?? 0) + 1);
  const rows = orders.map((order) => toCanceledRow(order, showRestaurant));
  return {
    ordersCount,
    canceledCount,
    // Contado na lista (os mais recentes, até MAX_ROWS): quem tem mais cancelamentos que isso já está em alerta.
    riskCount: rows.filter((row) => row.counted).length,
    fraudCount: rows.filter((row) => row.fraud).length,
    bySource: [...bySource].map(([channelType, count]) => ({ channelType, orders: count })).sort((a, b) => b.orders - a.orders),
    rows,
  };
}

/** O que fica guardado no pedido depois de o Jev analisar o caso (`orders.alert_analysis`). */
export const StoredAnalysis = z.object({
  /** Chance de fraude (0 a 1); null: só os endereços foram perguntados, ou o Jev não respondeu a esta pergunta. */
  risk: z.number().nullable(),
  /** Pedidos marcados como fraude em endereço parecido que o Jev deu como o mesmo local. */
  similar: z.array(z.string()),
  model: z.string(),
  at: z.string(),
});
export type StoredAnalysis = z.infer<typeof StoredAnalysis>;

/** A partir de quanto a chance de fraude é dada como alta, e até quanto como baixa (o alerta vira só um aviso). */
export const HIGH_RISK = 0.7;
export const LOW_RISK = 0.3;

/**
 * O nível pelas regras, sem a IA. `hard`: há pedido marcado como fraude (do cliente ou no endereço), e o alerta vale
 * sem perguntar ao Jev. O resto é proporção: 3 cancelamentos em 4 pedidos pesam mais que 5 em 300.
 */
function ruleLevel(cancellations: CustomerCancellations, addressMatches: number): { level: OrderAlertDto["level"] | null; hard: boolean } {
  if (cancellations.fraudCount > 0 || addressMatches > 0) return { level: "HIGH", hard: true };
  const { riskCount, ordersCount, rows } = cancellations;
  const ratio = riskCount / ordersCount;
  if (riskCount === 0 || ratio < FRAUD_RULES.lowRatio) return { level: null, hard: false };
  // Cancelado depois de sair para a entrega (o cliente recebeu, ou quase): um só já pesa.
  const afterDispatch = rows.some((row) => row.counted && row.afterDispatch);
  const high = afterDispatch || (riskCount >= FRAUD_RULES.highCount && ratio >= FRAUD_RULES.highRatio);
  return { level: high ? "HIGH" : "LOW", hard: false };
}

type AlertOrder = {
  id: string;
  status: OrderStatus;
  deliveryAddress: unknown;
  alertDecision: string | null;
  alertDecidedAt: Date | null;
  alertDecidedBy: { name: string } | null;
  alertAnalysis: unknown;
  fraudMarkedAt: Date | null;
};

function decisionOf(order: AlertOrder): OrderAlertDecision | null {
  if (!order.alertDecision || !order.alertDecidedAt) return null;
  const kind = order.alertDecision === "KEPT" ? "KEPT" : order.status === "CANCELED" ? "CANCELED" : "CANCELING";
  return { kind, by: order.alertDecidedBy?.name ?? null, at: order.alertDecidedAt.toISOString(), fraud: order.fraudMarkedAt !== null };
}

/**
 * Alerta de fraude do pedido. As regras decidem primeiro (`ruleLevel`): a proporção de cancelamentos do cliente (fora
 * este pedido) e o endereço de entrega idêntico ao de um pedido marcado como fraude, de qualquer cliente. O Jev só entra
 * depois, nos casos que as regras apontaram (FraudService.orderArrived), e o que ele respondeu fica em `alertAnalysis`:
 * risco baixo rebaixa o alerta a aviso, e endereço parecido confirmado conta como endereço marcado. Um pedido que
 * terminou sem decisão não tem mais o que decidir. `hard`: há pedido marcado como fraude, e a IA não muda o nível.
 */
export async function assessOrder(
  tx: TenantTx,
  order: AlertOrder,
  contact: ContactKeys & { name: string | null },
  actionable: boolean,
): Promise<{ alert: OrderAlertDto; hard: boolean } | null> {
  if (!order.alertDecision && !ACTIVE_ORDER.includes(order.status)) return null;
  const linked = linkedOrdersWhere(contact);
  const canceledWhere: Prisma.OrderWhereInput = { AND: [linked, { status: "CANCELED" }, { id: { not: order.id } }] };
  const [ordersCount, canceledCount, rows] = await Promise.all([
    tx.order.count({ where: { AND: [linked, { id: { not: order.id } }] } }),
    tx.order.count({ where: canceledWhere }),
    tx.order.findMany({ where: canceledWhere, include: rowInclude, orderBy: [{ placedAt: "desc" }, { id: "desc" }], take: MAX_ROWS }),
  ]);
  const analysis = StoredAnalysis.safeParse(order.alertAnalysis).data ?? null;
  const key = addressKey(order.deliveryAddress);
  const similar = analysis?.similar ?? [];
  const listed = new Set(rows.map((row) => row.id));
  const marked =
    key || similar.length
      ? await tx.order.findMany({
          where: {
            fraudMarkedAt: { not: null },
            id: { not: order.id },
            OR: [...(key ? [{ fraudAddressKey: key }] : []), ...(similar.length ? [{ id: { in: similar } }] : [])],
          },
          select: { id: true, placedAt: true, cancellationReason: true, fraudAddressKey: true, deliveryAddress: true, fraudMarkedBy: { select: { name: true } } },
          orderBy: { placedAt: "desc" },
          take: 20,
        })
      : [];
  // O pedido do próprio cliente já está na lista, com a marca: o bloco do endereço é para os dos outros.
  const matches = marked.filter((match) => !listed.has(match.id));
  // Com este pedido no total: "4 pedidos cancelados de 9 feitos".
  const cancellations = summarize(ordersCount + 1, canceledCount, rows);
  const rule = ruleLevel(cancellations, matches.length);
  const risk = analysis?.risk ?? null;
  const calmed = rule.level === "HIGH" && !rule.hard && risk !== null && risk <= LOW_RISK;
  // Decisão já tomada: o alerta continua à vista, mesmo que o histórico de hoje não o acionasse.
  const level = calmed ? "LOW" : (rule.level ?? (order.alertDecision ? "LOW" : null));
  if (!level) return null;
  return {
    hard: rule.hard,
    alert: {
      level,
      analysis: risk === null ? null : { risk, verdict: risk >= HIGH_RISK ? "high" : risk <= LOW_RISK ? "low" : "uncertain" },
      customerName: contact.name,
      cancellations,
      address: addressText(order.deliveryAddress),
      addressMatches: matches.map((match) => {
        const sameKey = key !== null && match.fraudAddressKey === key;
        return {
          placedAt: match.placedAt.toISOString(),
          reason: match.cancellationReason,
          markedBy: match.fraudMarkedBy?.name ?? null,
          similar: !sameKey,
          address: sameKey ? null : addressText(match.deliveryAddress),
        };
      }),
      decision: decisionOf(order),
      actionable,
    },
  };
}

export async function orderAlert(...args: Parameters<typeof assessOrder>): Promise<OrderAlertDto | null> {
  return (await assessOrder(...args))?.alert ?? null;
}

/**
 * Pedidos marcados como fraude em endereço parecido com o do pedido: mesma rua, número e cidade, com o resto escrito de
 * outro jeito. Sozinhos não contam; são o que o Jev compara. Os do próprio cliente já estão no histórico dele.
 */
export async function similarAddressCandidates(
  tx: TenantTx,
  order: { id: string; contactId: string; deliveryAddress: unknown },
): Promise<{ id: string; address: string }[]> {
  const key = addressKey(order.deliveryAddress);
  const base = addressBase(order.deliveryAddress);
  if (!key || !base) return [];
  const found = await tx.order.findMany({
    where: {
      fraudMarkedAt: { not: null },
      id: { not: order.id },
      contactId: { not: order.contactId },
      OR: [{ fraudAddressKey: base }, { fraudAddressKey: { startsWith: `${base}|` } }],
      NOT: { fraudAddressKey: key },
    },
    select: { id: true, deliveryAddress: true },
    orderBy: { fraudMarkedAt: "desc" },
    take: MAX_SIMILAR,
  });
  return found.flatMap((match) => {
    const address = addressText(match.deliveryAddress);
    return address ? [{ id: match.id, address }] : [];
  });
}

/** Cadastro do cliente e os ligados a ele por telefone, CPF ou e-mail (o par de `linkedOrdersWhere` para contatos). */
export function linkedContactsWhere(contact: ContactKeys): Prisma.ContactWhereInput {
  const phone = provenPhone(contact);
  return {
    OR: [
      { id: contact.id },
      ...(phone ? [provenPhoneWhere(phone)] : []),
      ...(contact.cpfHash ? [{ cpfHash: contact.cpfHash }] : []),
      ...(contact.email ? [{ email: { equals: contact.email, mode: "insensitive" as const } }] : []),
    ],
  };
}

/**
 * Clientes com um pedido à espera da decisão da equipe (selo "Alerta de fraude" na lista da Inbox). São poucos pedidos
 * por vez: de hoje ou de ontem, com alerta, em andamento e sem decisão.
 */
export async function contactsAwaitingDecision(tx: TenantTx, now = new Date()): Promise<Set<string>> {
  const orders = await tx.order.findMany({
    where: { alertAt: { not: null }, alertDecision: null, status: { in: ACTIVE_ORDER }, placedAt: { gte: startOfYesterday(now) } },
    select: { contact: { select: { id: true, phone: true, phoneSource: true, cpfHash: true, email: true } } },
    take: 200,
  });
  if (!orders.length) return new Set();
  const contacts = await tx.contact.findMany({ where: { OR: orders.map((order) => linkedContactsWhere(order.contact)) }, select: { id: true } });
  return new Set(contacts.map((contact) => contact.id));
}

/** Conversa em que o evento da decisão aparece: a do pedido ou a aberta do cliente; sem nenhuma, só fica no pedido. */
export async function conversationOfOrder(
  tx: TenantTx,
  order: { conversationId: string | null; contact: ContactKeys },
): Promise<{ id: string; tenantId: string; channelId: string } | null> {
  const select = { id: true, tenantId: true, channelId: true, status: true };
  const own = order.conversationId ? await tx.conversation.findUnique({ where: { id: order.conversationId }, select }) : null;
  if (own && own.status !== "RESOLVED") return own;
  return tx.conversation.findFirst({
    where: { status: { not: "RESOLVED" }, contact: linkedContactsWhere(order.contact) },
    orderBy: { lastMessageAt: { sort: "desc", nulls: "last" } },
    select,
  });
}
