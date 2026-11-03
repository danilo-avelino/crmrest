import type { Prisma, TenantTx } from "@dishdesk/database";
import type { ChannelType, OrderStatus } from "@dishdesk/database/enums";
import type { CanceledOrderRow, CustomerCancellations, OrderAlertDecision, OrderAlertDto } from "@dishdesk/shared";
import { startOfYesterday } from "../automations/automation.js";
import { addressKey, addressText } from "./address-key.js";
import { linkedOrdersWhere, provenPhone, provenPhoneWhere } from "./customer-history.js";

type ContactKeys = { id: string; phone: string | null; phoneSource: string | null; cpfHash: string | null; email: string | null };

/** Pedido ainda em andamento: é o que recebe o alerta. */
export const ACTIVE_ORDER: OrderStatus[] = ["PLACED", "CONFIRMED", "PREPARING", "READY", "DISPATCHED"];

/** A lista do alerta não precisa de mais que isso: o atendente decide pelos mais recentes. */
const MAX_ROWS = 100;

const rowInclude = {
  channel: { select: { type: true } },
  tenant: { select: { name: true } },
  fraudMarkedBy: { select: { name: true } },
} satisfies Prisma.OrderInclude;

type RowOrder = Prisma.OrderGetPayload<{ include: typeof rowInclude }>;

export function toCanceledRow(order: RowOrder, showRestaurant = false): CanceledOrderRow {
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

function summarize(ordersCount: number, canceledCount: number, rows: RowOrder[]): CustomerCancellations {
  const showRestaurant = new Set(rows.map((row) => row.tenantId)).size > 1;
  const bySource = new Map<ChannelType, number>();
  for (const row of rows) bySource.set(row.channel.type, (bySource.get(row.channel.type) ?? 0) + 1);
  return {
    ordersCount,
    canceledCount,
    fraudCount: rows.filter((row) => row.fraudMarkedAt).length,
    bySource: [...bySource].map(([channelType, orders]) => ({ channelType, orders })).sort((a, b) => b.orders - a.orders),
    rows: rows.map((row) => toCanceledRow(row, showRestaurant)),
  };
}

type AlertOrder = {
  id: string;
  status: OrderStatus;
  deliveryAddress: unknown;
  alertDecision: string | null;
  alertDecidedAt: Date | null;
  alertDecidedBy: { name: string } | null;
  fraudMarkedAt: Date | null;
};

function decisionOf(order: AlertOrder): OrderAlertDecision | null {
  if (!order.alertDecision || !order.alertDecidedAt) return null;
  const kind = order.alertDecision === "KEPT" ? "KEPT" : order.status === "CANCELED" ? "CANCELED" : "CANCELING";
  return { kind, by: order.alertDecidedBy?.name ?? null, at: order.alertDecidedAt.toISOString(), fraud: order.fraudMarkedAt !== null };
}

/**
 * Alerta de fraude do pedido: o cliente tem algum cancelamento (fora este pedido) ou o endereço de entrega é idêntico ao
 * de um pedido marcado como fraude, de qualquer cliente. Um pedido que terminou sem decisão não tem mais o que decidir.
 */
export async function orderAlert(
  tx: TenantTx,
  order: AlertOrder,
  contact: ContactKeys & { name: string | null },
  actionable: boolean,
): Promise<OrderAlertDto | null> {
  if (!order.alertDecision && !ACTIVE_ORDER.includes(order.status)) return null;
  const linked = linkedOrdersWhere(contact);
  const canceledWhere: Prisma.OrderWhereInput = { AND: [linked, { status: "CANCELED" }, { id: { not: order.id } }] };
  const [ordersCount, canceledCount, rows] = await Promise.all([
    tx.order.count({ where: { AND: [linked, { id: { not: order.id } }] } }),
    tx.order.count({ where: canceledWhere }),
    tx.order.findMany({ where: canceledWhere, include: rowInclude, orderBy: [{ placedAt: "desc" }, { id: "desc" }], take: MAX_ROWS }),
  ]);
  const key = addressKey(order.deliveryAddress);
  const listed = new Set(rows.map((row) => row.id));
  const marked = key
    ? await tx.order.findMany({
        where: { fraudAddressKey: key, fraudMarkedAt: { not: null }, id: { not: order.id } },
        select: { id: true, placedAt: true, cancellationReason: true, fraudMarkedBy: { select: { name: true } } },
        orderBy: { placedAt: "desc" },
        take: 20,
      })
    : [];
  // O pedido do próprio cliente já está na lista, com a marca: o bloco do endereço é para os dos outros.
  const matches = marked.filter((match) => !listed.has(match.id));
  if (canceledCount === 0 && matches.length === 0) return null;
  return {
    customerName: contact.name,
    // Com este pedido no total: "4 pedidos cancelados de 9 feitos".
    cancellations: summarize(ordersCount + 1, canceledCount, rows),
    address: addressText(order.deliveryAddress),
    addressMatches: matches.map((match) => ({
      placedAt: match.placedAt.toISOString(),
      reason: match.cancellationReason,
      markedBy: match.fraudMarkedBy?.name ?? null,
    })),
    decision: decisionOf(order),
    actionable,
  };
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
