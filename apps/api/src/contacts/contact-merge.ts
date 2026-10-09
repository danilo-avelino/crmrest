import type { Contact, TenantTx } from "@dishdesk/database";

export type MergeResult = { merged: true; contactId: string } | { merged: false; conflict: "telefone" | "CPF" };

/**
 * Une dois cadastros do mesmo cliente (ex.: o do WhatsApp e o de um pedido do iFood). Fica o mais antigo, completado
 * com o que só o outro tinha; identidades, conversas, pedidos, endereços e consentimentos passam para ele.
 * Telefones ou CPFs diferentes indicam pessoas diferentes: nesse caso nada é unido.
 */
export async function mergeContacts(tx: TenantTx, a: Contact, b: Contact, userId?: string): Promise<MergeResult> {
  if (a.id === b.id) return { merged: true, contactId: a.id };
  if (a.phone && b.phone && a.phone !== b.phone) return { merged: false, conflict: "telefone" };
  if (a.cpfHash && b.cpfHash && a.cpfHash !== b.cpfHash) return { merged: false, conflict: "CPF" };

  const [keep, drop] = a.firstSeenAt <= b.firstSeenAt ? [a, b] : [b, a];
  const move = { where: { contactId: drop.id }, data: { contactId: keep.id } };
  await tx.contactIdentity.updateMany(move);
  await tx.conversation.updateMany(move);
  await tx.order.updateMany(move);
  await tx.consent.updateMany(move);

  const kept = await tx.contactAddress.findMany({ where: { contactId: keep.id }, select: { street: true, number: true } });
  const known = new Set(kept.map((address) => `${address.street}|${address.number ?? ""}`));
  for (const address of await tx.contactAddress.findMany({ where: { contactId: drop.id }, select: { id: true, street: true, number: true } })) {
    if (known.has(`${address.street}|${address.number ?? ""}`)) await tx.contactAddress.delete({ where: { id: address.id } });
    else await tx.contactAddress.update({ where: { id: address.id }, data: { contactId: keep.id } });
  }

  await tx.contact.update({
    where: { id: keep.id },
    data: {
      ...(!keep.name && drop.name && { name: drop.name }),
      ...(!keep.phone && drop.phone && { phone: drop.phone, phoneSource: drop.phoneSource, phoneStatus: drop.phoneStatus }),
      ...(!keep.email && drop.email && { email: drop.email }),
      ...(!keep.cpfHash && drop.cpfHash && { cpfEncrypted: drop.cpfEncrypted, cpfHash: drop.cpfHash }),
      ...(!keep.birthDate && drop.birthDate && { birthDate: drop.birthDate }),
      ...(!keep.notes && drop.notes && { notes: drop.notes }),
      tags: [...new Set([...keep.tags, ...drop.tags])],
      ...(drop.lastSeenAt && (!keep.lastSeenAt || drop.lastSeenAt > keep.lastSeenAt) && { lastSeenAt: drop.lastSeenAt }),
    },
  });
  await tx.contact.delete({ where: { id: drop.id } });
  await tx.auditLog.create({
    data: { tenantId: keep.tenantId, userId, action: "contact.merged", entity: "contact", entityId: keep.id, data: { mergedContactId: drop.id } },
  });
  return { merged: true, contactId: keep.id };
}
