import type { Prisma, TenantTx } from "@dishdesk/database";
import type { CustomerHistory } from "@dishdesk/shared";

type ContactKeys = { id: string; phone: string | null; phoneSource: string | null; cpfHash: string | null; email: string | null };

/**
 * Telefone que identifica o cliente: o que o canal informa (WhatsApp) ou a equipe cadastrou. O que o cliente digitou
 * na conversa (Instagram, chat do iFood) não identifica: qualquer um digita o telefone de outra pessoa.
 */
export function provenPhone(contact: { phone: string | null; phoneSource: string | null }): string | null {
  return contact.phone && contact.phoneSource !== "informed_by_customer" ? contact.phone : null;
}

/** Outros cadastros cujo telefone identifica o cliente (o par de `provenPhone` numa consulta). */
export function provenPhoneWhere(phone: string): Prisma.ContactWhereInput {
  return { phone, OR: [{ phoneSource: null }, { phoneSource: { not: "informed_by_customer" } }] };
}

/**
 * Pedidos do cliente em todas as fontes: os do próprio cadastro (qualquer canal vinculado a ele) e os de outros
 * cadastros com o mesmo telefone, CPF ou e-mail (ex.: o cadastro do iFood, sem telefone, e o do Cardápio Web).
 * O telefone digitado pelo cliente na conversa não liga pedidos de outros cadastros.
 */
export function linkedOrdersWhere(contact: ContactKeys): Prisma.OrderWhereInput {
  const { id, cpfHash, email } = contact;
  const phone = provenPhone(contact);
  return {
    OR: [
      { contactId: id },
      ...(phone ? [{ contact: provenPhoneWhere(phone) }] : []),
      ...(cpfHash ? [{ contact: { cpfHash } }] : []),
      ...(email ? [{ contact: { email: { equals: email, mode: "insensitive" as const } } }] : []),
    ],
  };
}

/** "Este cliente tem X pedidos": total e valor de todas as fontes, sem os cancelados, e quantos vieram de cada uma. */
export async function customerHistory(tx: TenantTx, contact: ContactKeys): Promise<CustomerHistory> {
  const where: Prisma.OrderWhereInput = { AND: [linkedOrdersWhere(contact), { status: { not: "CANCELED" } }] };
  const groups = await tx.order.groupBy({ by: ["channelId"], where, _count: { _all: true }, _sum: { total: true } });
  const channels = await tx.channel.findMany({
    where: { id: { in: groups.map((group) => group.channelId) } },
    select: { id: true, type: true },
  });
  const typeOf = new Map(channels.map((channel) => [channel.id, channel.type]));
  const bySource = new Map<CustomerHistory["bySource"][number]["channelType"], number>();
  let total = 0;
  for (const group of groups) {
    const type = typeOf.get(group.channelId);
    if (type) bySource.set(type, (bySource.get(type) ?? 0) + group._count._all);
    total += Number(group._sum.total ?? 0);
  }
  return {
    orders: groups.reduce((sum, group) => sum + group._count._all, 0),
    total: total.toFixed(2),
    bySource: [...bySource].map(([channelType, orders]) => ({ channelType, orders })).sort((a, b) => b.orders - a.orders),
  };
}
